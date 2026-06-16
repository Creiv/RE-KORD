/**
 * Route di sistema: /api/health e /api/activity-log.
 * Estratto da index.mjs (Fase 6).
 */
import { readActivityLogs } from "../activityLog.mjs";
import { accountIdFromReq, sendError, sendOk } from "../httpUtils.mjs";
import { getMusicRoot, isLibraryRootConfigured } from "../musicRootConfig.mjs";
import { isServerAdminRequest } from "../requestAccess.mjs";
import { readUserState } from "../userState.mjs";
import { existsSync } from "fs";
import { isLibraryDbBootstrapped, getLibraryDb, getLibraryEpoch } from "../db/index.mjs";
import { rekordDbPath } from "../db/paths.mjs";

export function registerSystemRoutes(app) {
  app.get("/api/health", async (req, res) => {
    try {
      const envToken = String(process.env.REKORD_STARTUP_TOKEN || "").trim();
      const queryToken = String(req.query?.startupToken ?? "").trim();
      // REKORD_STARTUP_TOKEN is for Electron startup (localhost + ?startupToken=…).
      // Remote clients probe /api/health without the token; reject only a wrong non-empty token.
      if (envToken && queryToken && queryToken !== envToken) {
        return sendError(res, 503, "startup_token_mismatch");
      }

      const accountId = accountIdFromReq(req);
      if (!isLibraryRootConfigured()) {
        const payload = {
          exists: false,
          libraryRootConfigured: false,
          userStateVersion: null,
          accountId,
        };
        if (envToken && queryToken === envToken) payload.startupToken = envToken;
        if (isServerAdminRequest(req)) payload.musicRoot = null;
        return sendOk(res, payload);
      }
      const root = getMusicRoot();
      const state = await readUserState(root, accountId);
      const payload = {
        exists: existsSync(root),
        libraryRootConfigured: true,
        userStateVersion: state.version,
        accountId,
        libraryDb: { enabled: true },
      };
      try {
        const libraryDb = {
          enabled: true,
          bootstrapped: isLibraryDbBootstrapped(root),
          path: rekordDbPath(root),
          exists: existsSync(rekordDbPath(root)),
          epoch: getLibraryEpoch(root),
        };
        if (libraryDb.bootstrapped) {
          try {
            const db = getLibraryDb(root);
            libraryDb.stats = {
              artists: db.prepare("SELECT COUNT(*) AS c FROM artists").get().c,
              albums: db.prepare("SELECT COUNT(*) AS c FROM albums").get().c,
              tracks: db.prepare("SELECT COUNT(*) AS c FROM tracks").get().c,
              artwork: db.prepare("SELECT COUNT(*) AS c FROM artwork").get().c,
            };
          } catch {
            /* ok */
          }
        }
        payload.libraryDb = libraryDb;
      } catch (dbErr) {
        payload.libraryDb = {
          enabled: true,
          bootstrapped: false,
          error: String(dbErr?.message || dbErr),
        };
      }
      if (envToken && queryToken === envToken) payload.startupToken = envToken;
      if (isServerAdminRequest(req)) payload.musicRoot = root;
      return sendOk(res, payload);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/activity-log", async (req, res) => {
    try {
      const n = Number(req.query?.limit);
      const limit =
        Number.isFinite(n) && n > 0 ? Math.min(5000, Math.floor(n)) : 500;
      const entries = await readActivityLogs(limit);
      return sendOk(res, { entries });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });
}
