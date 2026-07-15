// @vitest-environment node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const ENV_KEYS = [
  "REKORD_USER_CONFIG_DIR",
  "MUSIC_ROOT",
  "REKORD_STARTUP_TOKEN",
  "REKORD_LOG_LEVEL",
] as const;

async function writeMinimalMp3(filePath: string) {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  await fs.writeFile(filePath, Buffer.concat([header, Buffer.alloc(128, 0)]));
}

describe("API integration", () => {
  let tmpRoot = "";
  let cfgDir = "";
  let libRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-int-"));
    cfgDir = path.join(tmpRoot, "cfg");
    libRoot = path.join(tmpRoot, "lib");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.mkdir(libRoot, { recursive: true });
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
      await import("../musicRootConfig.mjs");
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
    const { createApp } = await import("../createApp.mjs");
    return createApp();
  }

  it("GET /api/health reports library configured", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.libraryRootConfigured).toBe(true);
    expect(res.body.data.accountId).toBe("default");
  });

  it("GET /api/user-state returns default state", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/api/user-state");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.revision).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data.playlists)).toBe(true);
  });

  it("PUT /api/user-state with revision conflict returns 409", async () => {
    const app = await bootstrapLibrary();
    const initial = await request(app).get("/api/user-state");
    const rev = initial.body.data.revision;
    const ok = await request(app)
      .put("/api/user-state")
      .send({ expectedRevision: rev, favorites: ["Artist/Album/track.mp3"] });
    expect(ok.status).toBe(200);
    const conflict = await request(app)
      .put("/api/user-state")
      .send({ expectedRevision: rev, favorites: [] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("USER_STATE_REVISION_CONFLICT");
  });

  it("GET /media rejects path traversal", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/media/..%2f..%2fetc%2fpasswd");
    expect([404, 400]).toContain(res.status);
  });

  it("GET /media rejects symlinks escaping the library", async () => {
    const outside = path.join(tmpRoot, "outside.mp3");
    await writeMinimalMp3(outside);
    await fs.symlink(
      outside,
      path.join(libRoot, "Artist", "Album", "linked.mp3"),
    );
    const app = await bootstrapLibrary();
    const res = await request(app).get("/media/Artist/Album/linked.mp3");
    expect(res.status).toBe(404);
  });

  it("blocks sensitive account and backup operations through a public tunnel", async () => {
    const app = await bootstrapLibrary();
    const tunnelHeaders = {
      Host: "example.trycloudflare.com",
      "cf-connecting-ip": "203.0.113.10",
      "cf-ray": "test-MXP",
    };

    const account = await request(app)
      .post("/api/accounts")
      .set(tunnelHeaders)
      .send({ name: "Remote account" });
    expect(account.status).toBe(403);

    const backup = await request(app)
      .get("/api/backup/rekord-data")
      .set(tunnelHeaders);
    expect(backup.status).toBe(403);

    const restore = await request(app)
      .post("/api/backup/rekord-restore")
      .set(tunnelHeaders);
    expect(restore.status).toBe(400);

    const deletion = await request(app)
      .post("/api/fs/delete-album-folder")
      .set(tunnelHeaders)
      .send({ albumPath: "Artist/Album" });
    expect(deletion.status).toBe(403);

    const scan = await request(app)
      .post("/api/library/scan")
      .set(tunnelHeaders)
      .send({ full: true });
    expect(scan.status).toBe(403);

    // Le mutazioni account-scoped restano disponibili ai client autorizzati.
    const state = await request(app)
      .patch("/api/user-state")
      .set(tunnelHeaders)
      .send({ settings: { theme: "dark" } });
    expect(state.status).toBe(200);
  });

  it("GET /api/library-index consecutive calls share indexEpoch", async () => {
    const app = await bootstrapLibrary();
    const first = await request(app).get("/api/library-index");
    const second = await request(app).get("/api/library-index");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.indexEpoch).toBe(second.body.data.indexEpoch);
    expect(first.body.data.stats.trackCount).toBe(second.body.data.stats.trackCount);
  });

  it("GET /media serves same file twice with range support", async () => {
    const app = await bootstrapLibrary();
    const first = await request(app).get("/media/Artist/Album/track.mp3");
    const second = await request(app)
      .get("/media/Artist/Album/track.mp3")
      .set("Range", "bytes=0-99");
    expect(first.status).toBe(200);
    expect([200, 206]).toContain(second.status);
  });

  it("GET /api/library-snapshot returns index and dashboard", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/api/library-snapshot");
    expect(res.status).toBe(200);
    expect(res.body.data.index.stats.trackCount).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data.dashboard.continueListening)).toBe(true);
    expect(res.body.data.dashboard.continueListening.length).toBeLessThanOrEqual(30);
  });

  it("GET /api/library/delta unchanged for current epoch", async () => {
    const app = await bootstrapLibrary();
    const index = await request(app).get("/api/library-index");
    const epoch = index.body.data.indexEpoch;
    const res = await request(app).get(`/api/library/delta?sinceEpoch=${epoch}`);
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
  });

  it("GET /api/diagnostics returns version and uptime", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/api/diagnostics");
    expect(res.status).toBe(200);
    expect(res.body.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.body.data.uptimeMs).toBeGreaterThan(0);
  });

  it("GET /api/jobs returns job list", async () => {
    const app = await bootstrapLibrary();
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.jobs)).toBe(true);
  });
});
