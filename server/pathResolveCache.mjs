/**
 * LRU cache per realpath su file media — evita syscall sync ripetute su seek.
 */
import { statSync } from "node:fs";

const DEFAULT_MAX = 2000;

/** @type {Map<string, { realPath: string, mtimeMs: number }>} */
const cache = new Map();

function cacheKey(musicRoot, filePath) {
  return `${musicRoot}\0${filePath}`;
}

export function getCachedRealPath(musicRoot, filePath) {
  const key = cacheKey(musicRoot, filePath);
  const hit = cache.get(key);
  if (!hit) return null;
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    if (mtimeMs !== hit.mtimeMs) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit.realPath;
  } catch {
    cache.delete(key);
    return null;
  }
}

export function setCachedRealPath(musicRoot, filePath, realPath, mtimeMs) {
  const key = cacheKey(musicRoot, filePath);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { realPath, mtimeMs });
  while (cache.size > DEFAULT_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function clearPathResolveCache() {
  cache.clear();
}

export function pathResolveCacheSize() {
  return cache.size;
}
