/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import workerpool from 'workerpool';
import type { Ignore } from './ignore.js';

export interface CrawlOptions {
  // The directory to start the crawl from.
  crawlDirectory: string;
  // The project's root directory, for path relativity.
  cwd: string;
  // The fdir maxDepth option.
  maxDepth?: number;
  // A pre-configured Ignore instance.
  ignore: Ignore;
  // Caching options.
  cache: boolean;
  cacheTtl: number;
}

const pool = workerpool.pool(__dirname + '/crawler.worker.js', {
  maxWorkers: 1,
});

export async function crawl(options: CrawlOptions): Promise<string[]> {
  const ignorePatterns = options.ignore.serialize();
  const results = await pool.exec('crawl', [{ ...options, ignorePatterns }]);
  return results;
}

export async function terminateCrawlerWorker(): Promise<void> {
  await pool.terminate();
}
