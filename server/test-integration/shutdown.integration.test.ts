// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("gracefulShutdown", () => {
  let tmpRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-shutdown-"));
    savedEnv.REKORD_USER_CONFIG_DIR = process.env.REKORD_USER_CONFIG_DIR;
    savedEnv.MUSIC_ROOT = process.env.MUSIC_ROOT;
    savedEnv.REKORD_LOG_LEVEL = process.env.REKORD_LOG_LEVEL;
    process.env.REKORD_USER_CONFIG_DIR = path.join(tmpRoot, "cfg");
    process.env.REKORD_LOG_LEVEL = "silent";
    await fs.mkdir(process.env.REKORD_USER_CONFIG_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    if (savedEnv.REKORD_USER_CONFIG_DIR === undefined) delete process.env.REKORD_USER_CONFIG_DIR;
    else process.env.REKORD_USER_CONFIG_DIR = savedEnv.REKORD_USER_CONFIG_DIR;
    if (savedEnv.MUSIC_ROOT === undefined) delete process.env.MUSIC_ROOT;
    else process.env.MUSIC_ROOT = savedEnv.MUSIC_ROOT;
    if (savedEnv.REKORD_LOG_LEVEL === undefined) delete process.env.REKORD_LOG_LEVEL;
    else process.env.REKORD_LOG_LEVEL = savedEnv.REKORD_LOG_LEVEL;
    vi.resetModules();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("drains write chains before exit", async () => {
    const { atomicWriteFileUtf8, drainWriteChains } = await import("../rekordDataStore.mjs");
    const target = path.join(tmpRoot, "out.json");
    const pending = atomicWriteFileUtf8(target, JSON.stringify({ ok: true }));
    await drainWriteChains();
    await pending;
    const raw = await fs.readFile(target, "utf8");
    expect(JSON.parse(raw).ok).toBe(true);
  });
});
