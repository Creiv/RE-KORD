import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { sendError, sendOk } from "../httpUtils.mjs";
import { getMusicRoot, isLibraryRootConfigured, isLibraryRootWritable } from "../musicRootConfig.mjs";
import { isLibraryDbBootstrapped, getLibraryDb, getLibraryEpoch } from "../db/index.mjs";
import { rekordDbPath } from "../db/paths.mjs";
import { rekordArtworkDir } from "../db/paths.mjs";
import { getRecentErrors } from "../errorBuffer.mjs";
import { listJobs } from "../jobs/queue.mjs";
import { getRekordVersion } from "../rekordVersion.mjs";
import { isServerAdminRequest } from "../requestAccess.mjs";
import { watcherCount } from "../scanner/watcher.mjs";

const startedAt = Date.now();

function dirSizeBytes(dir) {
  try {
    if (!existsSync(dir)) return 0;
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          try {
            total += statSync(full).size;
          } catch {
            /* skip */
          }
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function registerDiagnosticsRoutes(app) {
  app.get("/api/diagnostics", async (req, res) => {
    try {
      const payload = {
        version: getRekordVersion(),
        uptimeMs: Date.now() - startedAt,
        libraryRootConfigured: isLibraryRootConfigured(),
        libraryWritable: isLibraryRootWritable(),
        jobs: listJobs().slice(0, 20),
        watchers: watcherCount(),
        recentErrors: getRecentErrors(25),
      };
      if (isLibraryRootConfigured()) {
        const root = getMusicRoot();
        payload.libraryDb = {
          bootstrapped: isLibraryDbBootstrapped(root),
          epoch: getLibraryEpoch(root),
        };
        // Path assoluto del DB solo per l'admin (come /api/health).
        if (isServerAdminRequest(req)) payload.libraryDb.path = rekordDbPath(root);
        payload.artworkCacheBytes = dirSizeBytes(rekordArtworkDir(root));
        try {
          const db = getLibraryDb(root);
          payload.libraryDb.stats = {
            artists: db.prepare("SELECT COUNT(*) AS c FROM artists").get().c,
            albums: db.prepare("SELECT COUNT(*) AS c FROM albums").get().c,
            tracks: db.prepare("SELECT COUNT(*) AS c FROM tracks").get().c,
          };
        } catch {
          /* ok */
        }
      }
      return sendOk(res, payload);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });
}
