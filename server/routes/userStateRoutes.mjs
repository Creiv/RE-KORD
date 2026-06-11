/**
 * Stato utente: dashboard, user-state, tema custom, cover, statistiche brano, best Plectr.
 * Estratto da index.mjs (Fase 6).
 */
import fs from "fs/promises";
import multer from "multer";
import path from "path";
import { diffUserStatePlaylistsAndSettings } from "../activityLog.mjs";
import {
  deleteCustomThemeBg,
  findCustomThemeBgPath,
  mediaTypeForThemeBgPath,
  saveCustomThemeBg,
} from "../customThemeBg.mjs";
import { accountIdFromReq, actLog, sendError, sendOk } from "../httpUtils.mjs";
import { getFilteredIndexForAccount } from "../libraryIndexService.mjs";
import { buildDashboard, coverCandidates, isAudioFile } from "../musicLibrary.mjs";
import { getMusicRoot } from "../musicRootConfig.mjs";
import {
  albumFolderFromRelPath,
  hasReservedPathSegment,
  pathHasParentDirSegment,
  safeRelSeg,
  underRoot,
} from "../pathSafety.mjs";
import {
  mergeAndWriteUserStatePatch,
  mergeAndWriteUserStateWithRevision,
  mergeUserStateForPut,
  readUserState,
  stripClientControlledKeysFromPutPatch,
  writeUserPlectrBestWithCAS,
} from "../userState.mjs";
import { existsSync, statSync } from "fs";

const uploadCustomThemeBg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

export function registerUserStateRoutes(app) {
  app.get("/api/dashboard", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const root = getMusicRoot();
      const [index, state] = await Promise.all([
        getFilteredIndexForAccount(accountId),
        readUserState(root, accountId),
      ]);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, buildDashboard(index, state));
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/user-state", async (req, res) => {
    try {
      const state = await readUserState(getMusicRoot(), accountIdFromReq(req));
      return sendOk(res, state);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/user-state/custom-theme-bg", async (req, res) => {
    try {
      const root = getMusicRoot();
      if (!root) return sendError(res, 428, "Library not configured");
      const accId = accountIdFromReq(req);
      const fp = findCustomThemeBgPath(root, accId);
      if (!fp) return sendError(res, 404, "Custom theme background not found");
      const buf = await fs.readFile(fp);
      res.setHeader("Content-Type", mediaTypeForThemeBgPath(fp));
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buf);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post(
    "/api/user-state/custom-theme-bg",
    uploadCustomThemeBg.single("file"),
    async (req, res) => {
      try {
        const root = getMusicRoot();
        if (!root) return sendError(res, 428, "Library not configured");
        if (!req.file?.buffer?.length) {
          return sendError(res, 400, "Missing or empty image file");
        }
        const accId = accountIdFromReq(req);
        const bgImage = await saveCustomThemeBg(
          root,
          accId,
          req.file.buffer,
          req.file.mimetype,
        );
        return sendOk(res, { bgImage, bgImageRev: Date.now() });
      } catch (error) {
        if (error?.code === "INVALID_IMAGE_TYPE") {
          return sendError(res, 400, String(error.message || error));
        }
        if (error?.code === "IMAGE_TOO_LARGE") {
          return sendError(res, 413, String(error.message || error));
        }
        return sendError(res, 500, String(error?.message || error));
      }
    },
  );

  app.delete("/api/user-state/custom-theme-bg", async (req, res) => {
    try {
      const root = getMusicRoot();
      if (!root) return sendError(res, 428, "Library not configured");
      const accId = accountIdFromReq(req);
      await deleteCustomThemeBg(root, accId);
      return sendOk(res, null);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.patch("/api/user-state", async (req, res) => {
    try {
      const accId = accountIdFromReq(req);
      const root = getMusicRoot();
      const nested = req.body?.state ?? req.body?.patch;
      let rawPatch = nested ?? req.body ?? {};
      if (
        nested == null &&
        rawPatch &&
        typeof rawPatch === "object" &&
        !Array.isArray(rawPatch)
      ) {
        const { expectedRevision: _er, ...rest } = rawPatch;
        void _er;
        rawPatch = rest;
      }
      if (
        rawPatch == null ||
        typeof rawPatch !== "object" ||
        Array.isArray(rawPatch)
      ) {
        return sendError(res, 400, "Invalid state patch: expected a JSON object");
      }
      const prevPeek = await readUserState(root, accId);
      const state = await mergeAndWriteUserStatePatch(
        root,
        accId,
        rawPatch,
      );
      for (const ev of diffUserStatePlaylistsAndSettings(prevPeek, state)) {
        void actLog(req, ev);
      }
      return sendOk(res, state);
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.put("/api/user-state", async (req, res) => {
    try {
      const accId = accountIdFromReq(req);
      const root = getMusicRoot();
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 1) {
        return sendError(res, 400, "expectedRevision (positive number) is required");
      }
      const nested = req.body?.state;
      let rawPatch = nested ?? req.body ?? {};
      if (
        nested == null &&
        rawPatch &&
        typeof rawPatch === "object" &&
        !Array.isArray(rawPatch)
      ) {
        const { expectedRevision: _er, ...rest } = rawPatch;
        void _er;
        rawPatch = rest;
      }
      if (
        rawPatch == null ||
        typeof rawPatch !== "object" ||
        Array.isArray(rawPatch)
      ) {
        return sendError(res, 400, "Invalid state: expected a JSON object");
      }
      const prevPeek = await readUserState(root, accId);
      const state = await mergeAndWriteUserStateWithRevision(
        root,
        accId,
        expectedRevision,
        (fresh) =>
          mergeUserStateForPut(
            fresh,
            stripClientControlledKeysFromPutPatch(rawPatch),
          ),
      );
      for (const ev of diffUserStatePlaylistsAndSettings(prevPeek, state)) {
        void actLog(req, ev);
      }
      return sendOk(res, state);
    } catch (error) {
      if (error?.code === "USER_STATE_REVISION_CONFLICT") {
        return sendError(res, 409, "USER_STATE_REVISION_CONFLICT", {
          code: "REVISION_CONFLICT",
          currentState: error.currentState,
        });
      }
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.patch("/api/user-state/settings", async (req, res) => {
    try {
      const accId = accountIdFromReq(req);
      const root = getMusicRoot();
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 1) {
        return sendError(res, 400, "expectedRevision (positive number) is required");
      }
      const rawPatch = req.body?.settings;
      if (rawPatch == null || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
        return sendError(res, 400, "Invalid settings patch: expected settings object");
      }
      const prevPeek = await readUserState(root, accId);
      const state = await mergeAndWriteUserStateWithRevision(
        root,
        accId,
        expectedRevision,
        (fresh) => mergeUserStateForPut(fresh, { settings: rawPatch }),
      );
      for (const ev of diffUserStatePlaylistsAndSettings(prevPeek, state)) {
        void actLog(req, ev);
      }
      return sendOk(res, state);
    } catch (error) {
      if (error?.code === "USER_STATE_REVISION_CONFLICT") {
        return sendError(res, 409, "USER_STATE_REVISION_CONFLICT", {
          code: "REVISION_CONFLICT",
          currentState: error.currentState,
        });
      }
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/cover", (req, res) => {
    const root = getMusicRoot();
    const relPath = String(req.query.path || "");
    if (
      !relPath ||
      pathHasParentDirSegment(relPath) ||
      hasReservedPathSegment(relPath)
    ) {
      return res.status(400).end();
    }
    const filePath = path.join(root, relPath.replaceAll("/", path.sep));
    if (!underRoot(filePath, root) || !existsSync(filePath))
      return res.status(404).end();
    const dir = statSync(filePath).isDirectory()
      ? filePath
      : path.dirname(filePath);
    for (const name of coverCandidates()) {
      const full = path.join(dir, name);
      if (existsSync(full) && underRoot(full, root)) {
        res.setHeader("Cache-Control", "private, max-age=86400, immutable");
        return res.sendFile(full);
      }
    }
    return res.status(404).end();
  });

  app.get("/api/track-stat", (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.query.path || ""));
    if (!relPath) return sendError(res, 400, "Missing path parameter");
    const filePath = path.join(root, relPath.replaceAll("/", path.sep));
    if (!underRoot(filePath, root) || !existsSync(filePath))
      return sendError(res, 404, "File not found");
    try {
      const st = statSync(filePath);
      return sendOk(res, { size: st.size, mtime: st.mtimeMs });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/plectr/save-best", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.body?.relPath || ""));
    const result = req.body?.result;
    if (!relPath) return sendError(res, 400, "relPath is required");
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return sendError(res, 400, "result object is required");
    }
    try {
      const fullTrackPath = path.join(root, relPath.replaceAll("/", path.sep));
      if (
        !underRoot(fullTrackPath, root) ||
        !existsSync(fullTrackPath) ||
        !isAudioFile(fullTrackPath)
      ) {
        return sendError(res, 404, "Track not found");
      }
      const parts = relPath.split("/").filter(Boolean);
      const fileName = parts[parts.length - 1];
      const albumRel = albumFolderFromRelPath(relPath);
      if (!albumRel) return sendError(res, 400, "Invalid track path");
      const accId = accountIdFromReq(req);
      const { saved, best } = await writeUserPlectrBestWithCAS(
        root,
        accId,
        relPath,
        result,
      );
      void actLog(req, {
        kind: "library",
        action: "plectr_best_save",
        folder: albumRel,
        detail: `${fileName}: ${best?.score ?? result.score}${saved ? "" : " (unchanged)"}`,
      });
      const trackDelta = {
        relPath,
        meta: { plectrBest: best ?? null },
      };
      return res.json({
        ok: true,
        relPath,
        saved,
        meta: { plectrBest: best ?? null },
        track: trackDelta,
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

}
