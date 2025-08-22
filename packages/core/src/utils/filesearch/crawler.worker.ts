/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as workerpool from 'workerpool';
import { Ignore } from './ignore.js';
import * as cache from './crawlCache.js';
import path from 'node:path';
import { fdir } from 'fdir';
import { CrawlOptions, WorkerCrawlOptions } from './crawler.js';

// Helper function to configure the fdir API based on options
function _configureFdirApi(
  options: CrawlOptions,
  dirFilter: (path: string) => boolean,
  posixCwd: string,
): fdir {
  const api = new fdir().withDirs().withPathSeparator('/'); // Always use unix style paths

  if (options.crawlDirectory === options.cwd) {
    api.withRelativePaths();
  } else {
    api.withFullPaths();
  }

  if (options.maxDepth !== undefined) {
    api.withMaxDepth(options.maxDepth);
  }

  api.exclude((_, dirPath) => {
    // dirPath is absolute. We need to make it relative to the ignore directory
    const pathRelativeToCwd = globalThis.ActualPath.posix.relative(
      posixCwd,
      dirPath,
    );
    return dirFilter(`${pathRelativeToCwd}/`);
  });
  return api;
}

// Helper function to process the raw crawl results into final relative paths
async function _processCrawlResults(
  rawResults: string[],
  options: CrawlOptions,
  posixCwd: string,
): Promise<string[]> {
  // Drop the `.` entry.
  rawResults = rawResults.slice(1);

  if (options.crawlDirectory === options.cwd) {
    return rawResults; // Already relative
  } else {
    const relativeToCwdResults: string[] = [];
    for (const [i, p] of rawResults.entries()) {
      if (i % 1000 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      let relativePath = globalThis.ActualPath.posix.relative(posixCwd, p);
      // If the original path was a directory (ended with '/'), ensure the relative path also ends with '/'
      if (p.endsWith('/') && !relativePath.endsWith('/')) {
        relativePath += '/';
      }
      relativeToCwdResults.push(relativePath);
    }
    return relativeToCwdResults;
  }
}

// This is the actual crawling logic that will run in the worker thread.
export async function _crawlInternal(
  workerOptions: WorkerCrawlOptions,
): Promise<string[]> {
  const options: CrawlOptions = {
    ...workerOptions,
    ignore: globalThis.ActualIgnore.fromJSON(workerOptions.ignore),
  };

  if (options.cache) {
    const cacheKey = globalThis.ActualCache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
    );
    const cachedResults = globalThis.ActualCache.read(cacheKey);

    if (cachedResults) {
      return cachedResults;
    }
  }

  const posixCwd = options.cwd
    .split(globalThis.ActualPath.sep)
    .join(globalThis.ActualPath.posix.sep);
  const dirFilter = options.ignore.getDirectoryFilter();
  let finalResults: string[];

  try {
    const api = _configureFdirApi(options, dirFilter, posixCwd);
    const rawResults = await api.crawl(options.crawlDirectory).withPromise();

    finalResults = await _processCrawlResults(rawResults, options, posixCwd);
  } catch (_e) {
    // The directory probably doesn't exist.
    return [];
  }

  if (options.cache) {
    const cacheKey = globalThis.ActualCache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
    );
    globalThis.ActualCache.write(
      cacheKey,
      finalResults,
      options.cacheTtl * 1000,
    );
  }

  return finalResults;
}

// Expose globals needed by _crawlInternal in the worker thread
declare global {
  var ActualIgnore: typeof Ignore;
  var ActualCache: typeof cache;
  var ActualPath: typeof path;
}
globalThis.ActualIgnore = Ignore;
globalThis.ActualCache = cache;
globalThis.ActualPath = path;

workerpool.worker({ _crawlInternal });
