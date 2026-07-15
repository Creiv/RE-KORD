// @vitest-environment node
import fs from "fs/promises";
import { statSync } from "node:fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPathResolveCache,
  getCachedRealPath,
  pathResolveCacheSize,
  setCachedRealPath,
} from "./pathResolveCache.mjs";

describe("pathResolveCache", () => {
  let tmp = "";
  let filePath = "";

  beforeEach(async () => {
    clearPathResolveCache();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-path-cache-"));
    filePath = path.join(tmp, "track.mp3");
    await fs.writeFile(filePath, "audio");
  });

  afterEach(async () => {
    clearPathResolveCache();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("restituisce realPath in cache hit", () => {
    const mtimeMs = statSync(filePath).mtimeMs;
    setCachedRealPath(tmp, filePath, filePath, mtimeMs);
    expect(getCachedRealPath(tmp, filePath)).toBe(filePath);
  });

  it("invalida cache se mtime cambia", async () => {
    const mtimeMs = statSync(filePath).mtimeMs;
    setCachedRealPath(tmp, filePath, filePath, mtimeMs);
    const now = Date.now();
    await fs.utimes(filePath, new Date(now), new Date(now));
    expect(getCachedRealPath(tmp, filePath)).toBeNull();
  });

  it("rispetta il cap LRU", () => {
    for (let i = 0; i < 2005; i++) {
      setCachedRealPath(tmp, `/f/${i}`, `/r/${i}`, i);
    }
    expect(pathResolveCacheSize()).toBeLessThanOrEqual(2000);
  });
});
