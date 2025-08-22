/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import { Ignore } from './ignore.js';

declare global {
  var ActualIgnore: typeof Ignore;
  var ActualCache: typeof cache;
  var ActualPath: typeof path;
}

import * as cache from './crawlCache.js';
import * as workerpool from 'workerpool';

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

export interface WorkerCrawlOptions extends Omit<CrawlOptions, 'ignore'> {
  ignore: { patterns: string[] };
}

const pool = workerpool.pool(path.join(__dirname, './crawler.worker.js'));

// This is the public crawl function that will be called from the main thread.
export async function crawl(options: CrawlOptions): Promise<string[]> {
  const serializedOptions: WorkerCrawlOptions = {
    ...options,
    ignore: options.ignore.toJSON(),
  };
  try {
    const results = await pool.exec('_crawlInternal', [serializedOptions]);
    return results;
  } catch (e) {
    console.error('[crawl] Worker error:', e);
    throw e; // Re-throw to propagate the error
  }
}
