/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { BaseTool, ToolResult } from './tools.js';
import { shortenPath, makeRelative } from '../utils/paths.js';
import { Config } from '../config/config.js';

// Subset of 'Path' interface provided by 'glob' that we can implement for testing
export interface GlobPath {
  fullpath(): string;
  mtimeMs?: number;
}

/**
 * Parameters for the GlobTool
 */
export interface GlobToolParams {
  /**
   * The glob pattern to match files against
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory)
   */
  path?: string;

  /**
   * Whether the search should be case-sensitive (optional, defaults to false)
   */
  case_sensitive?: boolean;

  /**
   * Whether to respect .gitignore patterns (optional, defaults to true)
   */
  respect_git_ignore?: boolean;
}

/**
 * Implementation of the Glob tool logic
 */
export class GlobTool extends BaseTool<GlobToolParams, ToolResult> {
  static readonly Name = 'glob';
  /**
   * Creates a new instance of the GlobLogic
   * @param rootDirectory Root directory to ground this tool in.
   */
  constructor(
    private rootDirectory: string,
    private config: Config,
  ) {
    super(
      GlobTool.Name,
      'FindFiles',
      'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.',
      {
        properties: {
          pattern: {
            description:
              "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md').",
            type: 'string',
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the root directory.',
            type: 'string',
          },
          case_sensitive: {
            description:
              'Optional: Whether the search should be case-sensitive. Defaults to false.',
            type: 'boolean',
          },
          respect_git_ignore: {
            description:
              'Optional: Whether to respect .gitignore patterns when finding files. Only available in git repositories. Defaults to true.',
            type: 'boolean',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );

    this.rootDirectory = path.resolve(rootDirectory);
  }

  /**
   * Checks if a path is within the root directory.
   */
  private isWithinRoot(pathToCheck: string): boolean {
    const absolutePathToCheck = path.resolve(pathToCheck);
    const normalizedPath = path.normalize(absolutePathToCheck);
    const normalizedRoot = path.normalize(this.rootDirectory);
    const rootWithSep = normalizedRoot.endsWith(path.sep)
      ? normalizedRoot
      : normalizedRoot + path.sep;
    return (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(rootWithSep)
    );
  }

  /**
   * Validates the parameters for the tool.
   */
  validateToolParams(params: GlobToolParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(
        this.schema.parameters as Record<string, unknown>,
        params,
      )
    ) {
      return "Parameters failed schema validation. Ensure 'pattern' is a string, 'path' (if provided) is a string, and 'case_sensitive' (if provided) is a boolean.";
    }

    const searchDirAbsolute = path.resolve(
      this.rootDirectory,
      params.path || '.',
    );

    if (!this.isWithinRoot(searchDirAbsolute)) {
      return `Search path ("${searchDirAbsolute}") resolves outside the tool's root directory ("${this.rootDirectory}").`;
    }

    try {
      // Check if the path exists and is a directory synchronously
      const stats = fs.statSync(searchDirAbsolute);
      if (!stats.isDirectory()) {
        return `Search path is not a directory: ${searchDirAbsolute}`;
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Search path does not exist: ${searchDirAbsolute}`;
      }
      return `Error accessing search path: ${e}`;
    }

    if (
      !params.pattern ||
      typeof params.pattern !== 'string' ||
      params.pattern.trim() === ''
    ) {
      return "The 'pattern' parameter cannot be empty.";
    }

    return null;
  }

  /**
   * Gets a description of the glob operation.
   */
  getDescription(params: GlobToolParams): string {
    let description = `'${params.pattern}'`;
    if (params.path) {
      const searchDir = path.resolve(this.rootDirectory, params.path || '.');
      const relativePath = makeRelative(searchDir, this.rootDirectory);
      description += ` within ${shortenPath(relativePath)}`;
    }
    return description;
  }

  /**
   * Executes the glob search with the given parameters
   */
  async execute(
    params: GlobToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
      };
    }

    try {
      const searchDirAbsolute = path.resolve(
        this.rootDirectory,
        params.path || '.',
      );

      const args = ['--files'];

      if (params.case_sensitive) {
        args.push('--glob', params.pattern);
      } else {
        args.push('--iglob', params.pattern);
      }

      if (params.respect_git_ignore === false) {
        args.push('--no-ignore');
      }

      // Always include hidden files in glob searches
      args.push('--hidden');

      const rg = spawn(rgPath, args, {
        cwd: searchDirAbsolute,
        signal,
      });

      let stdout = '';
      let stderr = '';

      rg.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      return new Promise((resolve, reject) => {
        rg.on('close', async (code) => {
          if (code === 0 || code === 1) {
            const files = stdout
              .split('\n')
              .map((file) => file.trim())
              .filter((file) => file.length > 0)
              .map((file) => path.join(searchDirAbsolute, file));

            const fileStats = files.map((file) => {
              try {
                const stats = fs.statSync(file);
                return { fullpath: () => file, mtimeMs: stats.mtimeMs };
              } catch (e) {
                console.warn(`Could not get stats for file ${file}: ${e}`);
                return { fullpath: () => file, mtimeMs: 0 }; // Default to 0 if stats fail
              }
            });

            // Sort files by modification time (newest first)
            fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

            const sortedAbsolutePaths = fileStats.map((entry) =>
              entry.fullpath(),
            );
            const fileListDescription = sortedAbsolutePaths.join('\n');
            const fileCount = sortedAbsolutePaths.length;

            let resultMessage;
            if (fileCount === 0) {
              resultMessage = `No files found matching pattern "${params.pattern}"`;
            } else {
              resultMessage = `Found ${fileCount} file(s) matching "${params.pattern}" within ${searchDirAbsolute}`;
              resultMessage += `, sorted by modification time (newest first):\n${fileListDescription}`;
            }

            resolve({
              llmContent: resultMessage,
              returnDisplay:
                fileCount === 0
                  ? 'No files found'
                  : `Found ${fileCount} matching file(s)`,
            });
          } else {
            const errorMessage = `ripgrep exited with code ${code}. Stderr: ${stderr}`;
            console.error(errorMessage);
            reject(new Error(errorMessage));
          }
        });

        rg.on('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`GlobLogic execute Error: ${errorMessage}`, error);
      return {
        llmContent: `Error during glob search operation: ${errorMessage}`,
        returnDisplay: `Error: An unexpected error occurred.`,
      };
    }
  }
}
