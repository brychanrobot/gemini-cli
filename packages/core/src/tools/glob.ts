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
import globToRegexp from 'glob-to-regexp';

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
      'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths. Ideal for quickly locating files based on their name or path structure, especially in large codebases.',
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

      const fileCache = this.config.getFileCacheService();
      // Get all files from the cache, respecting .gitignore settings.
      // This is more efficient than hitting the filesystem for every glob command.
      const allFiles = await fileCache.getAllFiles(
        params.respect_git_ignore ?? true,
      );

      // If a path is provided, join it with the pattern to create a single
      // glob pattern. This allows us to match against the full list of files
      // from the cache.
      const globPattern = params.path
        ? path.join(params.path, params.pattern)
        : params.pattern;

      // Convert the glob pattern to a regular expression for use with ripgrep.
      const regexPattern = globToRegexp(globPattern, {
        extended: true,
        globstar: true,
      }).source.replace(/\\\//g, '/'); // Get the regex string and unescape forward slashes

      const rgArgs = ['-e', regexPattern, '-']; // Read from stdin
      if (!params.case_sensitive) {
        rgArgs.push('--ignore-case');
      }

      const rgProcess = spawn(rgPath, rgArgs, {
        cwd: this.rootDirectory,
        signal,
      });

      rgProcess.stdin.write(allFiles.join('\n'));
      rgProcess.stdin.end();

      let stdout = '';
      let stderr = '';

      rgProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      rgProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      await new Promise<void>((resolve, reject) => {
        rgProcess.on('close', (code) => {
          if (code === 0 || code === 1) {
            resolve();
          } else {
            reject(
              new Error(`ripgrep exited with code ${code}. Stderr: ${stderr}`),
            );
          }
        });
        rgProcess.on('error', (err) => {
          reject(err);
        });
      });

      const matchingFiles = stdout
        .split('\n')
        .filter((line) => line.trim() !== '');

      const absolutePaths = matchingFiles.map((file) =>
        path.join(this.rootDirectory, file),
      );

      const fileListDescription = absolutePaths.join('\n');
      const fileCount = absolutePaths.length;

      let resultMessage;
      if (fileCount === 0) {
        resultMessage = `No files found matching pattern "${params.pattern}"`;
      } else {
        resultMessage = `Found ${fileCount} file(s) matching "${
          params.pattern
        }" within ${searchDirAbsolute}`;
        resultMessage += `:\n${fileListDescription}`;
      }

      return {
        llmContent: resultMessage,
        returnDisplay:
          fileCount === 0
            ? 'No files found'
            : `Found ${fileCount} matching file(s)`,
      };
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
