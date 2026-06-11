/**
 * Backup e restore dei dati RE-KORD (zip).
 * Estratto da index.mjs (Fase 6).
 */
import multer from "multer";
import { restoreRekordFromZipBuffer, streamRekordBackupZip } from "../backupRekord.mjs";
import { sendError, sendOk } from "../httpUtils.mjs";
import { invalidateLibraryIndex } from "../libraryIndexService.mjs";
import { getAccountsSnapshot, getMusicRoot, isMusicRootFromEnv } from "../musicRootConfig.mjs";

const uploadRekordBackup = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

export function registerBackupRoutes(app) {
  const handleRekordBackupDownload = async (req, res) => {
    try {
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

  const handleRekordBackupRestore = async (req, res) => {
    try {
      if (isMusicRootFromEnv()) {
        return sendError(
          res,
          403,
          "Restore is not available when MUSIC_ROOT is set in the environment",
        );
      }
      if (!req.file?.buffer?.length) {
        return sendError(res, 400, "Missing or empty file");
      }
      const data = await restoreRekordFromZipBuffer(req.file.buffer);
      await invalidateLibraryIndex(getMusicRoot());
      return sendOk(res, data);
    } catch (error) {
      if (error?.code === "ENV_LOCKED") {
        return sendError(res, 403, String(error.message || error));
      }
      if (error?.code === "BAD_BACKUP") {
        return sendError(res, 400, String(error.message || error));
      }
      return sendError(res, 500, String(error?.message || error));
    }
  };

  app.post("/api/backup/rekord-restore", uploadRekordBackup.single("file"), handleRekordBackupRestore);
  app.post("/api/backup/kord-restore", uploadRekordBackup.single("file"), handleRekordBackupRestore);
}
