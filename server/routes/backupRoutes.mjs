/**
 * Backup e restore dei dati RE-KORD (zip) + export/import tema condivisibile.
 * Estratto da index.mjs (Fase 6).
 */
import multer from "multer";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";
import unzipper from "unzipper";
import { restoreKordFromZipPath, streamRekordBackupZip } from "../backupRekord.mjs";
import {
  findCustomThemeBgPath,
  mediaTypeForThemeBgPath,
  saveCustomThemeBg,
} from "../customThemeBg.mjs";
import { accountIdFromReq, sendError, sendOk } from "../httpUtils.mjs";
import { getAccountsSnapshot, getMusicRoot, isMusicRootFromEnv } from "../musicRootConfig.mjs";
import { isServerAdminRequest } from "../requestAccess.mjs";
import { mergeAndWriteUserStatePatch, readUserState } from "../userState.mjs";

const uploadRekordBackup = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, callback) => {
      callback(null, `rekord-restore-upload-${randomUUID()}.zip`);
    },
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});
const uploadThemeArchive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const THEME_EXPORT_JSON = "rekord-theme.json";

/** Se lo zip è un export tema (contiene rekord-theme.json) ne restituisce
 *  payload + eventuale immagine di sfondo; altrimenti null (è un backup). */
async function readThemeZip(source) {
  let dir;
  try {
    dir = Buffer.isBuffer(source)
      ? await unzipper.Open.buffer(source)
      : await unzipper.Open.file(source);
  } catch {
    return null;
  }
  const jsonEntry = dir.files.find(
    (f) => f.type !== "Directory" && path.posix.basename(f.path) === THEME_EXPORT_JSON,
  );
  if (!jsonEntry) return null;
  let payload;
  try {
    payload = JSON.parse((await jsonEntry.buffer()).toString("utf8"));
  } catch {
    payload = null;
  }
  if (!payload || payload.kind !== "rekord-theme") {
    const err = new Error("Invalid theme archive: bad rekord-theme.json");
    err.code = "BAD_THEME";
    throw err;
  }
  let background = null;
  if (typeof payload.backgroundFile === "string" && payload.backgroundFile.trim()) {
    const base = path.posix.basename(payload.backgroundFile.trim());
    const bgEntry = dir.files.find(
      (f) => f.type !== "Directory" && path.posix.basename(f.path) === base,
    );
    if (bgEntry) background = { buffer: await bgEntry.buffer(), name: base };
  }
  return { payload, background };
}

/** Costruisce la patch settings dal payload tema: solo dati del tema, niente utente. */
function themeSettingsPatchFromPayload(payload) {
  const out = {};
  if (typeof payload.theme === "string" && payload.theme.trim()) {
    out.theme = payload.theme.trim();
  }
  if (typeof payload.glassSurfaces === "boolean") {
    out.glassSurfaces = payload.glassSurfaces;
  }
  if (Number.isFinite(Number(payload.glassOpacity))) {
    out.glassOpacity = Number(payload.glassOpacity);
  }
  if (payload.customTheme && typeof payload.customTheme === "object") {
    const ct = { ...payload.customTheme };
    delete ct.bgImage;
    delete ct.bgImageRev;
    out.customTheme = ct;
  }
  return out;
}

export function registerBackupRoutes(app) {
  const selectRestoreUploadPolicy = (req, res, next) => {
    const upload = isServerAdminRequest(req)
      ? uploadRekordBackup
      : uploadThemeArchive;
    return upload.single("file")(req, res, (error) => {
      if (error?.code === "LIMIT_FILE_SIZE") {
        return sendError(res, 413, "Archive is too large");
      }
      if (error) return next(error);
      return next();
    });
  };

  const handleRekordBackupDownload = async (req, res) => {
    try {
      if (!isServerAdminRequest(req)) {
        return sendError(res, 403, "Server admin access required");
      }
      const name = `rekord-backup-${new Date()
      .toISOString()
      .replaceAll(":", "-")}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      await streamRekordBackupZip(res, getAccountsSnapshot);
    } catch (error) {
      if (!res.headersSent) {
        return sendError(res, 500, String(error?.message || error));
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  };

  app.get("/api/backup/rekord-data", handleRekordBackupDownload);
  app.get("/api/backup/kord-data", handleRekordBackupDownload);

  /** Export tema condivisibile: zip "rekord-theme/" con json + sfondo custom.
   *  Solo dati del tema corrente — nessuna informazione sull'utente. */
  app.get("/api/backup/theme-export", async (req, res) => {
    try {
      const root = getMusicRoot();
      if (!root) return sendError(res, 428, "Library not configured");
      const accId = accountIdFromReq(req);
      const state = await readUserState(root, accId);
      const s = state?.settings || {};
      const payload = {
        kind: "rekord-theme",
        version: 1,
        theme: s.theme,
        glassSurfaces: s.glassSurfaces === true,
        glassOpacity: s.glassOpacity,
      };
      let bgFile = null;
      if (s.theme === "custom" && s.customTheme) {
        const ct = { ...s.customTheme };
        delete ct.bgImage;
        delete ct.bgImageRev;
        payload.customTheme = ct;
        if (s.customTheme.bgMode === "image") {
          const fp = findCustomThemeBgPath(root, accId);
          if (fp) {
            const name = `background${path.extname(fp) || ".jpg"}`;
            bgFile = { fp, name };
            payload.backgroundFile = name;
          } else {
            payload.customTheme = { ...ct, bgMode: "color" };
          }
        }
      }
      const themeLabel =
        String(s.theme || "theme").replace(/[^a-z0-9-]/gi, "") || "theme";
      const name = `rekord-theme-${themeLabel}-${new Date()
        .toISOString()
        .slice(0, 10)}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      const zip = archiver("zip", { zlib: { level: 9 } });
      zip.on("error", () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
      zip.pipe(res);
      zip.append(JSON.stringify(payload, null, 2), {
        name: `rekord-theme/${THEME_EXPORT_JSON}`,
      });
      if (bgFile) zip.file(bgFile.fp, { name: `rekord-theme/${bgFile.name}` });
      await zip.finalize();
    } catch (error) {
      if (!res.headersSent) {
        return sendError(res, 500, String(error?.message || error));
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });

  const handleRekordBackupRestore = async (req, res) => {
    try {
      const uploadSource = req.file?.path || req.file?.buffer;
      if (!uploadSource || (!req.file?.path && !req.file?.buffer?.length)) {
        return sendError(res, 400, "Missing or empty file");
      }

      // Export tema? Importa solo le impostazioni del tema sull'account corrente.
      const theme = await readThemeZip(uploadSource);
      if (theme) {
        const root = getMusicRoot();
        if (!root) return sendError(res, 428, "Library not configured");
        const accId = accountIdFromReq(req);
        const settingsPatch = themeSettingsPatchFromPayload(theme.payload);
        if (theme.background) {
          const mime = mediaTypeForThemeBgPath(theme.background.name);
          const bgImage = await saveCustomThemeBg(
            root,
            accId,
            theme.background.buffer,
            mime,
          );
          settingsPatch.customTheme = {
            ...(settingsPatch.customTheme || {}),
            bgImage,
            bgImageRev: Date.now(),
            bgMode: "image",
          };
        } else if (settingsPatch.customTheme?.bgMode === "image") {
          settingsPatch.customTheme = {
            ...settingsPatch.customTheme,
            bgMode: "color",
          };
        }
        const state = await mergeAndWriteUserStatePatch(root, accId, {
          settings: settingsPatch,
        });
        return sendOk(res, {
          themeImported: true,
          theme: state?.settings?.theme ?? null,
        });
      }

      if (!isServerAdminRequest(req)) {
        return sendError(res, 403, "Server admin access required");
      }
      if (isMusicRootFromEnv()) {
        return sendError(
          res,
          403,
          "Restore is not available when MUSIC_ROOT is set in the environment",
        );
      }
      const data = await restoreKordFromZipPath(req.file.path);
      return sendOk(res, data);
    } catch (error) {
      if (error?.code === "ENV_LOCKED") {
        return sendError(res, 403, String(error.message || error));
      }
      if (error?.code === "BAD_BACKUP" || error?.code === "BAD_THEME") {
        return sendError(res, 400, String(error.message || error));
      }
      if (error?.code === "INVALID_IMAGE_TYPE") {
        return sendError(res, 400, String(error.message || error));
      }
      return sendError(res, 500, String(error?.message || error));
    } finally {
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
    }
  };

  app.post("/api/backup/rekord-restore", selectRestoreUploadPolicy, handleRekordBackupRestore);
  app.post("/api/backup/kord-restore", selectRestoreUploadPolicy, handleRekordBackupRestore);
}
