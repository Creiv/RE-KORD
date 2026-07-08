// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

describe("upgrade 4.4 naming/data", () => {
  let tmpRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-upg-"));
    savedEnv.REKORD_USER_CONFIG_DIR = process.env.REKORD_USER_CONFIG_DIR;
    savedEnv.MUSIC_ROOT = process.env.MUSIC_ROOT;
    savedEnv.REKORD_LOG_LEVEL = process.env.REKORD_LOG_LEVEL;
    process.env.REKORD_LOG_LEVEL = "silent";
    vi.resetModules();
  });

  afterEach(async () => {
    for (const key of ["REKORD_USER_CONFIG_DIR", "MUSIC_ROOT", "REKORD_LOG_LEVEL"] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("reads legacy user-state and bumps revision on write", async () => {
    const cfgDir = path.join(tmpRoot, "cfg");
    const libRoot = path.join(tmpRoot, "lib");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.mkdir(path.join(libRoot, ".kord", "default_info"), { recursive: true });
    await fs.writeFile(
      path.join(libRoot, ".kord", "default_info", "user-state.json"),
      JSON.stringify(
        {
          version: 1,
          favorites: ["legacy.mp3"],
          playlists: [{ name: "Legacy", tracks: [] }],
          queue: { tracks: [], currentIndex: 0 },
          settings: { theme: "midnight", locale: "en" },
        },
        null,
        2,
      ),
    );
    process.env.REKORD_USER_CONFIG_DIR = cfgDir;
    await fs.writeFile(
      path.join(cfgDir, "music-root.config.json"),
      JSON.stringify({
        musicRoot: libRoot,
        schemaVersion: 3,
        accounts: [{ id: "default", name: "Default" }],
      }),
    );
    const { reloadConfigFromDisk, waitForInitialLayoutMigration } = await import("../musicRootConfig.mjs");
    reloadConfigFromDisk();
    await waitForInitialLayoutMigration();
    const { createApp } = await import("../createApp.mjs");
    const app = createApp();
    const get = await request(app).get("/api/user-state");
    expect(get.body.data.favorites).toEqual(["legacy.mp3"]);
    expect(get.body.data.revision).toBeGreaterThanOrEqual(1);
    const rev = get.body.data.revision;
    const put = await request(app)
      .put("/api/user-state")
      .send({ expectedRevision: rev, favorites: ["legacy.mp3", "new.mp3"] });
    expect(put.status).toBe(200);
    expect(put.body.data.revision).toBe(rev + 1);
  });
});
