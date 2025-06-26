/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';

import path from 'path';
import { EOL } from 'os';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';

// --- Interfaces ---

/**
 * Parameters for the GrepTool
 */
export interface GrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

// --- GrepLogic Class ---

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class GrepTool extends BaseTool<GrepToolParams, ToolResult> {
  static readonly Name = 'search_file_content'; // Keep static name

  /**
   * Creates a new instance of the GrepLogic
   * @param rootDirectory Root directory to ground this tool in. All operations will be restricted to this directory.
   */
  constructor(private rootDirectory: string) {
    super(
      GrepTool.Name,
      'SearchText',
      'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.',
      {
        properties: {
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: 'string',
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
            type: 'string',
          },
          include: {
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: 'string',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );
    // Ensure rootDirectory is absolute and normalized
    this.rootDirectory = path.resolve(rootDirectory);
  }

  // --- Validation Methods ---

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string {
    const targetPath = path.resolve(this.rootDirectory, relativePath || '.');

    // Security Check: Ensure the resolved path is still within the root directory.
    if (
      !targetPath.startsWith(this.rootDirectory) &&
      targetPath !== this.rootDirectory
    ) {
      throw new Error(
        `Path validation failed: Attempted path "${relativePath || '.'}" resolves outside the allowed root directory "${this.rootDirectory}".`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParams(params: GrepToolParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(
        this.schema.parameters as Record<string, unknown>,
        params,
      )
    ) {
      return 'Parameters failed schema validation.';
    }

    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern provided: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }

    try {
      this.resolveAndValidatePath(params.path);
    } catch (error) {
      return getErrorMessage(error);
    }

    return null; // Parameters are valid
  }

  // --- Core Execution ---

  /**
   * Executes the grep search with the given parameters
   * @param params Parameters for the grep search
   * @returns Result of the grep search
   */
  async execute(
    params: GrepToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Model provided invalid parameters. Error: ${validationError}`,
      };
    }

    let searchDirAbs: string;
    try {
      searchDirAbs = this.resolveAndValidatePath(params.path);
      const searchDirDisplay = params.path || '.';

      const matches: GrepMatch[] = await this.performGrepSearch({
        pattern: params.pattern,
        path: searchDirAbs,
        include: params.include,
        signal,
      });

      if (matches.length === 0) {
        const noMatchMsg = `No matches found for pattern "${params.pattern}" in path "${searchDirDisplay}"${params.include ? ` (filter: "${params.include}")` : ''}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      const matchesByFile = matches.reduce(
        (acc, match) => {
          const relativeFilePath =
            path.relative(
              searchDirAbs,
              path.resolve(searchDirAbs, match.filePath),
            ) || path.basename(match.filePath);
          if (!acc[relativeFilePath]) {
            acc[relativeFilePath] = [];
          }
          acc[relativeFilePath].push(match);
          acc[relativeFilePath].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      let llmContent = `Found ${matches.length} match(es) for pattern "${params.pattern}" in path "${searchDirDisplay}"${params.include ? ` (filter: "${params.include}")` : ''}:\n---\n`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      return {
        llmContent: llmContent.trim(),
        returnDisplay: `Found ${matches.length} matche(s)`,
      };
    } catch (error) {
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  // --- Grep Implementation Logic ---

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(params: GrepToolParams): string {
    let description = `'${params.pattern}'`;
    if (params.include) {
      description += ` in ${params.include}`;
    }
    if (params.path) {
      const resolvedPath = path.resolve(this.rootDirectory, params.path);
      if (resolvedPath === this.rootDirectory || params.path === '.') {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(resolvedPath, this.rootDirectory);
        description += ` within ${shortenPath(relativePath)}`;
      }
    }
    return description;
  }

  /**
   * Performs the actual search using ripgrep.
   * @param options Search options including pattern, absolute path, and include glob.
   * @returns A promise resolving to an array of match objects.
   */
  private async performGrepSearch(options: {
    pattern: string;
    path: string; // Expects absolute path
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include, signal } = options;
    const rgArgs = [
      '--json', // Output results in JSON format
      '--pcre2', // Use PCRE2 regex engine for better compatibility
      '--ignore-case', // Case-insensitive search
      '--multiline', // Search across multiple lines
      '--trim', // Remove leading/trailing whitespace from results
      '--max-columns',
      '1000', // Increase column limit to avoid truncation
      '--max-columns-preview', // Show preview of long lines
      '--heading', // Show file names as headings
      '--with-filename', // Include filename in results
      '--line-number', // Include line number in results
      '--color',
      'never', // Disable color output
      '--glob',
      '!**/.git/*', // Ignore .git directory
      '--glob',
      '!**/node_modules/*', // Ignore node_modules directory
      '--glob',
      '!**/bower_components/*', // Ignore bower_components directory
      '--glob',
      '!**/.svn/*', // Ignore .svn directory
      '--glob',
      '!**/.hg/*', // Ignore .hg directory
    ];

    // Add include glob if provided
    if (include) {
      rgArgs.push('--glob', include);
    }

    // Add the pattern and path
    rgArgs.push(pattern);
    rgArgs.push(absolutePath);

    return new Promise((resolve, reject) => {
      const child = spawn(rgPath, rgArgs, {
        cwd: absolutePath,
        windowsHide: true,
        signal,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      child.on('error', (err) => {
        reject(new Error(`Failed to start ripgrep: ${err.message}`));
      });

      child.on('close', (code) => {
        const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrData = Buffer.concat(stderrChunks).toString('utf8');

        if (code === 0) {
          // Success, parse JSON output
          const matches: GrepMatch[] = [];
          stdoutData.split(EOL).forEach((line) => {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'match') {
                  const filePath = parsed.data.path.text;
                  const startLineNumber = parsed.data.line_number;
                  const rawLineContent = parsed.data.lines.text;
                  const lines = rawLineContent
                    .split(/\r?\n/)
                    .filter((l: string) => l.length > 0);

                  lines.forEach((line: string, index: number) => {
                    matches.push({
                      filePath: path.relative(absolutePath, filePath),
                      lineNumber: startLineNumber + index,
                      line: line.trim(),
                    });
                  });
                }
              } catch (jsonError) {
                console.error(
                  `Error parsing ripgrep JSON line: ${line}`,
                  jsonError,
                );
              }
            }
          });
          resolve(matches);
        } else if (code === 1) {
          // No matches found
          resolve([]);
        } else {
          // Error
          reject(
            new Error(
              `ripgrep exited with code ${code}: ${stderrData || 'Unknown error'}`,
            ),
          );
        }
      });
    });
  }
}
