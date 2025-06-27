/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';

const CACHE_TTL_MS = 10000; // 10 seconds

interface CacheEntry {
  timestamp: number;
  files: string[];
}

export class FileCacheService {
  private cache: Map<string, CacheEntry> = new Map();

  constructor(private rootDirectory: string) {}

  async getAllFiles(
    respectGitIgnore: boolean,
    relativePath = '.',
  ): Promise<string[]> {
    const cacheKey = `${respectGitIgnore}:${relativePath}`;
    const now = Date.now();
    const cachedEntry = this.cache.get(cacheKey);

    if (cachedEntry && now - cachedEntry.timestamp < CACHE_TTL_MS) {
      return cachedEntry.files;
    }

    const files = await this.fetchFilesFromRipgrep(
      respectGitIgnore,
      relativePath,
    );
    this.cache.set(cacheKey, { timestamp: now, files });
    return files;
  }

  private fetchFilesFromRipgrep(
    respectGitIgnore: boolean,
    relativePath: string,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = ['--files', '--hidden'];
      if (!respectGitIgnore) {
        args.push('--no-ignore');
      }

      const rg = spawn(rgPath, args, {
        cwd: `${this.rootDirectory}/${relativePath}`,
      });

      let stdout = '';
      let stderr = '';

      rg.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      rg.on('close', (code) => {
        if (code === 0 || code === 1) {
          const files = stdout
            .split('\n')
            .map((file) => file.trim())
            .filter((file) => file.length > 0)
            .map((file) =>
              relativePath === '.' ? file : `${relativePath}/${file}`,
            );
          resolve(files);
        } else {
          reject(
            new Error(`ripgrep exited with code ${code}. Stderr: ${stderr}`),
          );
        }
      });

      rg.on('error', (err) => {
        reject(err);
      });
    });
  }
}
