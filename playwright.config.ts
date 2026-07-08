import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// La fixture va creata prima dell'avvio del webServer (config load time).
const e2eRoot = path.join(os.tmpdir(), `rekord-e2e-${process.pid}`);
const cfgDir = path.join(e2eRoot, "cfg");
const libRoot = path.join(e2eRoot, "lib");
mkdirSync(cfgDir, { recursive: true });
mkdirSync(path.join(libRoot, "Artist", "Album"), { recursive: true });
writeFileSync(
  path.join(cfgDir, "music-root.config.json"),
  JSON.stringify(
    {
      musicRoot: libRoot,
      schemaVersion: 3,
      accounts: [{ id: "default", name: "Default" }],
    },
    null,
    2,
  ),
);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node server/index.mjs",
      port: 3001,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        REKORD_USER_CONFIG_DIR: cfgDir,
        MUSIC_ROOT: libRoot,
        REKORD_LOG_LEVEL: "silent",
        REKORD_FS_WATCH: "0",
      },
    },
    {
      command: "npm run preview -- --host 127.0.0.1 --port 4173",
      port: 4173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
