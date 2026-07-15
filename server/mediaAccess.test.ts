// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["REKORD_USER_CONFIG_DIR", "MUSIC_ROOT", "REKORD_LOG_LEVEL"] as const;

async function writeMinimalMp3(filePath: string) {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  await fs.writeFile(filePath, Buffer.concat([header, Buffer.alloc(128, 0)]));
}

describe("mediaAccess", () => {
  let tmpRoot = "";
  let cfgDir = "";
  let libRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-media-"));
    cfgDir = path.join(tmpRoot, "cfg");
    libRoot = path.join(tmpRoot, "lib");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.mkdir(path.join(libRoot, "Artist", "Album"), { recursive: true });
    await writeMinimalMp3(path.join(libRoot, "Artist", "Album", "track.mp3"));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.REKORD_USER_CONFIG_DIR = cfgDir;
    process.env.REKORD_LOG_LEVEL = "silent";
    vi.resetModules();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function bootstrapLibrary() {
    const { CONFIG_FILE, reloadConfigFromDisk, waitForInitialLayoutMigration } =
      await import("./musicRootConfig.mjs");
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify(
        {
          musicRoot: libRoot,
          schemaVersion: 3,
          accounts: [{ id: "default", name: "Default" }],
        },
        null,
        2,
      ),
      "utf8",
    );
    reloadConfigFromDisk();
    await waitForInitialLayoutMigration();
    const { getLibraryIndex } = await import("./libraryIndexService.mjs");
    await getLibraryIndex(libRoot);
  }

  function mockReq(remoteAddress: string, query: Record<string, string> = {}) {
    return {
      socket: { remoteAddress },
      query,
      headers: {},
    };
  }

  it("consente loopback senza accountId", async () => {
    await bootstrapLibrary();
    const { validateMediaAccess, resetMediaAccessCacheForTests } = await import(
      "./mediaAccess.mjs"
    );
    resetMediaAccessCacheForTests();
    const result = await validateMediaAccess(
      mockReq("127.0.0.1"),
      "Artist/Album/track.mp3",
    );
    expect(result).toEqual({ ok: true });
  });

  it("rifiuta client LAN senza account valido", async () => {
    await bootstrapLibrary();
    const { validateMediaAccess, resetMediaAccessCacheForTests } = await import(
      "./mediaAccess.mjs"
    );
    resetMediaAccessCacheForTests();
    const result = await validateMediaAccess(
      mockReq("192.168.1.50"),
      "Artist/Album/track.mp3",
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("consente client LAN con accountId e brano in libreria", async () => {
    await bootstrapLibrary();
    const { validateMediaAccess, resetMediaAccessCacheForTests } = await import(
      "./mediaAccess.mjs"
    );
    resetMediaAccessCacheForTests();
    const result = await validateMediaAccess(
      mockReq("192.168.1.50", { accountId: "default" }),
      "Artist/Album/track.mp3",
    );
    expect(result).toEqual({ ok: true });
  });
});
