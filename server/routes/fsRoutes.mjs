/**
 * Filesystem libreria: list, ricerca cartelle, mkdir, pulizie e cancellazioni.
 * Estratto da index.mjs (Fase 6).
 */
import fs from "fs/promises";
import path from "path";
import { sendError, sendOk } from "../httpUtils.mjs";
import { invalidateLibraryIndex } from "../libraryIndexService.mjs";
import { isAudioFile } from "../musicLibrary.mjs";
import { getMusicRoot } from "../musicRootConfig.mjs";
import { albumFolderFromRelPath, safeRelSeg, underRoot } from "../pathSafety.mjs";
import { relPathLooksLikeAlbumFolder } from "../ytdlpStudio.mjs";
import { existsSync, statSync } from "fs";

export function registerFsRoutes(app) {
  app.get("/api/fs/list", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.query.path || ""));
    if (relPath == null) return sendError(res, 400, "Invalid path");
    try {
      const full = path.join(root, relPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full))
        return sendError(
          res,
          400,
          "Path is outside the library or does not exist"
        );
      const st = statSync(full);
      if (!st.isDirectory()) return sendError(res, 400, "Not a directory");
      const entries = await fs.readdir(full, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .filter((entry) => entry.name !== "kord" && entry.name !== "node_modules")
        .map((entry) => ({
          name: entry.name,
          relPath: relPath ? `${relPath}/${entry.name}` : entry.name,
        }))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true })
        );
      return res.json({
        path: relPath,
        parent: relPath.split("/").filter(Boolean).slice(0, -1).join("/") || "",
        dirs,
        musicRoot: root,
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/fs/search-dirs", async (req, res) => {
    const root = getMusicRoot();
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 1) return sendOk(res, { results: [] });
    if (q.length > 80) return sendError(res, 400, "Query too long");
    try {
      const results = [];
      const visit = async (dir, relPath) => {
        if (results.length >= 80) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= 80) break;
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".")) continue;
          if (entry.name === "kord" || entry.name === "node_modules") continue;
          const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          const full = path.join(root, childRel.replaceAll("/", path.sep));
          if (!underRoot(full, root)) continue;
          if (childRel.toLowerCase().includes(q)) {
            results.push({ name: entry.name, relPath: childRel });
          }
          await visit(full, childRel);
        }
      };
      await visit(root, "");
      return sendOk(res, { results });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/fs/mkdir", async (req, res) => {
    const root = getMusicRoot();
    const parentRaw = req.body?.parent;
    const parent = safeRelSeg(String(parentRaw == null ? "" : parentRaw));
    if (parent == null && parentRaw != null && String(parentRaw) !== "") {
      return sendError(res, 400, "Invalid parent path");
    }
    if (relPathLooksLikeAlbumFolder(parent ?? "")) {
      return sendError(
        res,
        400,
        "Cannot create a folder inside an album path (use an artist folder)",
      );
    }
    const name = String(req.body?.name || "").trim();
    if (name.length < 1 || name.length > 200)
      return sendError(res, 400, "Name too short or too long");
    if (
      name.includes("/") ||
      name === ".." ||
      name === "." ||
      name === "kord" ||
      name === "node_modules"
    ) {
      return sendError(res, 400, "Invalid name");
    }
    try {
      const relPath = parent ? `${parent}/${name}` : name;
      const full = path.join(root, relPath.replaceAll("/", path.sep));
      if (!underRoot(full, root)) return sendError(res, 400, "Invalid path");
      if (existsSync(full)) return sendError(res, 400, "Folder already exists");
      await fs.mkdir(full, { recursive: false });
      await invalidateLibraryIndex(root);
      return res.json({ ok: true, relPath: relPath.replaceAll(path.sep, "/") });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/fs/clear-dl-dest", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.body?.path ?? ""));
    if (relPath == null) return sendError(res, 400, "Invalid path");
    if (String(req.body?.path ?? "").trim() === "" || !relPath) {
      return sendError(
        res,
        400,
        "Use a subfolder under Music, not the library root"
      );
    }
    try {
      const full = path.join(root, relPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full))
        return sendError(
          res,
          400,
          "Path is outside the library or does not exist"
        );
      const st = statSync(full);
      if (!st.isDirectory()) return sendError(res, 400, "Not a directory");
      const deleted = [];
      const baseRel = relPath.replaceAll(path.sep, "/");
      const walk = async (dir, relFromRoot) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const p = path.join(dir, e.name);
          const rel = relFromRoot ? `${relFromRoot}/${e.name}` : e.name;
          const relNorm = rel.replaceAll(path.sep, "/");
          if (e.isDirectory()) {
            if (e.name === "kord" || e.name === "node_modules") continue;
            await walk(p, relNorm);
          } else if (e.isFile() && isAudioFile(e.name)) {
            await fs.unlink(p);
            deleted.push(relNorm);
          }
        }
      };
      await walk(full, baseRel);
      await invalidateLibraryIndex(root);
      return sendOk(res, { deleted });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/fs/delete-audio-relpaths", async (req, res) => {
    const root = getMusicRoot();
    const list = Array.isArray(req.body?.relPaths) ? req.body.relPaths : [];
    const deleted = [];
    try {
      for (const item of list) {
        const rel = safeRelSeg(String(item));
        if (rel == null || !String(rel).trim()) continue;
        const full = path.join(root, rel.replaceAll("/", path.sep));
        if (!underRoot(full, root) || !existsSync(full)) continue;
        const st0 = statSync(full);
        if (!st0.isFile()) continue;
        const base = path.basename(full);
        if (!isAudioFile(base)) continue;
        await fs.unlink(full);
        deleted.push(rel.replaceAll(path.sep, "/"));
      }
      await invalidateLibraryIndex(root);
      return sendOk(res, {
        deleted,
        affectedAlbums: [...new Set(deleted.map((rel) => albumFolderFromRelPath(rel)).filter(Boolean))],
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/fs/delete-album-folder", async (req, res) => {
    const root = getMusicRoot();
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    if (albumPath == null || !albumPath)
      return sendError(res, 400, "albumPath is required");
    if (albumPath.split("/").filter(Boolean).length < 2) {
      return sendError(
        res,
        400,
        "albumPath must be an album folder under an artist"
      );
    }
    try {
      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full)) {
        return sendError(res, 404, "Album folder not found");
      }
      const st = statSync(full);
      if (!st.isDirectory()) return sendError(res, 400, "Not a directory");
      const deleted = [];
      const collectAudio = async (dir, relFromRoot) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const child = path.join(dir, e.name);
          const rel = `${relFromRoot}/${e.name}`.replaceAll(path.sep, "/");
          if (e.isDirectory()) {
            await collectAudio(child, rel);
          } else if (e.isFile() && isAudioFile(e.name)) {
            deleted.push(rel);
          }
        }
      };
      await collectAudio(full, albumPath.replaceAll(path.sep, "/"));
      if (!deleted.length)
        return sendError(res, 400, "No audio files in album folder");
      await fs.rm(full, { recursive: true, force: false });
      await invalidateLibraryIndex(root);
      return sendOk(res, {
        deleted,
        deletedFolder: albumPath.replaceAll(path.sep, "/"),
        affectedAlbums: [albumPath.replaceAll(path.sep, "/")],
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

}
