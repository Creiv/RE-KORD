/**
 * Metadati: artwork, info album/brano, testi, prune orfani, sanitizzazione titoli.
 * Estratto da index.mjs (Fase 6).
 */
import fs from "fs/promises";
import path from "path";
import {
  fetchReleaseMetadata,
  fetchTrackLyricsLrcLib,
  fetchTrackMetadata,
  loadAlbumJsonMetaFromDir,
  loadTrackJsonMetaMapFromDir,
  prepareTrackTitleForMeta,
  pruneOrphanTrackMetaInAlbumDir,
  sanitizeTrackTitlesFullLibrary,
  sanitizeTrackTitlesInAlbumDir,
  saveAlbumFetchedMeta,
  saveAlbumManualMeta,
  saveTrackFetchedMeta,
  saveTrackManualMeta,
} from "../albumInfo.mjs";
import { aggregateArtworkSearch } from "../artworkSearch.mjs";
import { getAudioFileDurationMs } from "../audioDuration.mjs";
import { normalizeStoredGenreString, parseTrackGenres } from "../genres.mjs";
import { accountIdFromReq, actLog, sendError, sendOk } from "../httpUtils.mjs";
import {
  patchAlbumInLibraryIndexCache,
  patchTrackInLibraryIndexCache,
  patchTracksInLibraryIndexCache,
} from "../libraryIndexCache.mjs";
import {
  albumDeltaFromMeta,
  invalidateLibraryIndex,
  scheduleLibraryIndexMetaRefresh,
} from "../libraryIndexService.mjs";
import { isAudioFile } from "../musicLibrary.mjs";
import { getMusicRoot } from "../musicRootConfig.mjs";
import {
  albumFolderFromRelPath,
  hostnameBlockedForUpstreamImageFetch,
  safeRelSeg,
  underRoot,
} from "../pathSafety.mjs";
import { rekordApiUserAgent } from "../rekordVersion.mjs";
import { existingAlbumTrackInfoPath } from "../trackInfoPaths.mjs";
import { normalizeTrackMoodsList } from "../trackMoods.mjs";
import { writeUserTrackMoodsWithCAS } from "../userState.mjs";
import { existsSync, statSync } from "fs";
import multer from "multer";

const uploadAlbumCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

export function registerMetadataRoutes(app) {
  app.get("/api/artwork/search", async (req, res) => {
    const q = String(req.query.q || req.query.term || "").trim();
    const artist = String(req.query.artist || "").trim();
    const album = String(req.query.album || "").trim();
    const terms = [];
    if (q) terms.push(q);
    else {
      const both = [artist, album].filter(Boolean).join(" ");
      if (both) terms.push(both);
      if (artist) terms.push(artist);
      if (album) terms.push(album);
    }
    const unique = [
      ...new Set(
        terms.map((term) => term.trim()).filter((term) => term.length > 1)
      ),
    ];
    if (!unique.length) return sendOk(res, { results: [] });
    try {
      const results = await aggregateArtworkSearch(unique);
      return sendOk(res, { results });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/artwork/apply", async (req, res) => {
    const root = getMusicRoot();
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!albumPath)
      return sendError(
        res,
        400,
        "albumPath: relative folder (e.g. Artist/Album)"
      );
    if (!/^https?:\/\//i.test(imageUrl))
      return sendError(res, 400, "Provide a valid http(s) image URL");
    try {
      let parsedImg;
      try {
        parsedImg = new URL(imageUrl);
      } catch {
        return sendError(res, 400, "Invalid image URL");
      }
      if (hostnameBlockedForUpstreamImageFetch(parsedImg.hostname))
        return sendError(res, 400, "Image hostname not allowed");

      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full))
        return sendError(res, 400, "Folder does not exist");
      if (!statSync(full).isDirectory())
        return sendError(res, 400, "Not a directory");
      const response = await fetch(imageUrl, {
        headers: { "User-Agent": rekordApiUserAgent() },
      });
      if (!response.ok) return sendError(res, 400, "Image download failed");
      const type = (response.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/"))
        return sendError(res, 400, "URL is not an image");
      const ext = type.includes("png") ? "png" : "jpg";
      const dest = path.join(full, `cover.${ext}`);
      const data = await response.arrayBuffer();
      await fs.writeFile(dest, Buffer.from(data));
      void actLog(req, {
        kind: "studio",
        action: "cover_save",
        folder: albumPath,
        detail: path.basename(dest),
      });
      const coverRelPath = `${albumPath}/${path.basename(dest)}`.replaceAll(
        path.sep,
        "/",
      );
      const cachePatched = await patchAlbumInLibraryIndexCache(root, albumPath, {
        coverRelPath,
      });
      scheduleLibraryIndexMetaRefresh(root, cachePatched);
      return sendOk(res, {
        saved: path.basename(dest),
        albumPath,
        abs: dest,
        coverRelPath,
        coverVersion: Date.now(),
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post(
    "/api/artwork/upload",
    uploadAlbumCover.single("file"),
    async (req, res) => {
      const root = getMusicRoot();
      const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
      if (!albumPath)
        return sendError(
          res,
          400,
          "albumPath: relative folder (e.g. Artist/Album)"
        );
      if (!req.file?.buffer?.length)
        return sendError(res, 400, "Missing or empty image file");
      const mime = String(req.file.mimetype || "").toLowerCase();
      const ext =
        mime === "image/png"
          ? "png"
          : mime === "image/jpeg" || mime === "image/jpg"
            ? "jpg"
            : null;
      if (!ext)
        return sendError(res, 400, "Only JPEG or PNG images are supported");
      try {
        const full = path.join(root, albumPath.replaceAll("/", path.sep));
        if (!underRoot(full, root) || !existsSync(full))
          return sendError(res, 400, "Folder does not exist");
        if (!statSync(full).isDirectory())
          return sendError(res, 400, "Not a directory");
        const dest = path.join(full, `cover.${ext}`);
        await fs.writeFile(dest, req.file.buffer);
        void actLog(req, {
          kind: "studio",
          action: "cover_save",
          folder: albumPath,
          detail: path.basename(dest),
        });
        const coverRelPath = `${albumPath}/${path.basename(dest)}`.replaceAll(
          path.sep,
          "/",
        );
        const cachePatched = await patchAlbumInLibraryIndexCache(
          root,
          albumPath,
          { coverRelPath },
        );
        scheduleLibraryIndexMetaRefresh(root, cachePatched);
        return sendOk(res, {
          saved: path.basename(dest),
          albumPath,
          abs: dest,
          coverRelPath,
          coverVersion: Date.now(),
        });
      } catch (error) {
        return sendError(res, 500, String(error?.message || error));
      }
    },
  );

  app.post("/api/album-info/fetch", async (req, res) => {
    const root = getMusicRoot();
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    const artist = String(req.body?.artist || "").trim();
    const albumTitle = String(req.body?.album || "").trim();
    if (!albumPath) return sendError(res, 400, "albumPath is required");
    try {
      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full))
        return sendError(res, 400, "Folder does not exist");
      if (!statSync(full).isDirectory())
        return sendError(res, 400, "Not a directory");
      const meta = await fetchReleaseMetadata(artist, albumTitle);
      if (meta.error) return sendError(res, 404, meta.error);
      const payload = { ...meta, fetchedAt: new Date().toISOString() };
      delete payload.error;
      const savedMeta = await saveAlbumFetchedMeta(full, payload);
      void actLog(req, {
        kind: "library",
        action: "album_metadata_fetch",
        folder: albumPath,
        detail: "MusicBrainz / release metadata",
      });
      const albumDelta = albumDeltaFromMeta(albumPath, savedMeta, albumTitle);
      const cachePatched = await patchAlbumInLibraryIndexCache(
        root,
        albumPath,
        albumDelta,
      );
      scheduleLibraryIndexMetaRefresh(root, cachePatched);
      return res.json({ ok: true, albumPath, meta: savedMeta, album: albumDelta });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/album-info/save", async (req, res) => {
    const root = getMusicRoot();
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    const patch = req.body?.patch;
    if (!albumPath) return sendError(res, 400, "albumPath is required");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return sendError(res, 400, "patch object is required");
    }
    try {
      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full))
        return sendError(res, 400, "Folder does not exist");
      if (!statSync(full).isDirectory())
        return sendError(res, 400, "Not a directory");
      const allowed = [
        "title",
        "releaseDate",
        "genre",
        "label",
        "country",
        "musicbrainzReleaseId",
      ];
      const safe = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) safe[k] = patch[k];
      }
      if (!Object.keys(safe).length)
        return sendError(res, 400, "No valid fields in patch");
      const genreTouched = Object.prototype.hasOwnProperty.call(safe, "genre");
      const prevAlbumGenre = genreTouched
        ? normalizeStoredGenreString((await loadAlbumJsonMetaFromDir(full))?.genre) || null
        : null;
      const meta = await saveAlbumManualMeta(full, safe);
      const touchedTracks = [];
      if (genreTouched) {
        const prevAlbumGenres = new Set(
          parseTrackGenres(prevAlbumGenre).map((g) => g.toLowerCase())
        );
        const nextAlbumGenres = parseTrackGenres(meta?.genre);
        const trackMetaMap = await loadTrackJsonMetaMapFromDir(full);
        const entries = await fs.readdir(full, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !isAudioFile(entry.name)) continue;
          const existingGenres = parseTrackGenres(trackMetaMap?.[entry.name]?.genre);
          const mergedGenres = existingGenres.filter(
            (g) => !prevAlbumGenres.has(g.toLowerCase())
          );
          for (const g of nextAlbumGenres) {
            if (!mergedGenres.some((x) => x.toLowerCase() === g.toLowerCase())) {
              mergedGenres.push(g);
            }
          }
          const relPath = `${albumPath}/${entry.name}`.replaceAll(path.sep, "/");
          const row = await saveTrackManualMeta(full, entry.name, {
            genre: normalizeStoredGenreString(mergedGenres.join("; ")) || null,
          });
          touchedTracks.push({
            relPath,
            meta: row,
          });
        }
      }
      void actLog(req, {
        kind: "library",
        action: "album_metadata_save",
        folder: albumPath,
        detail: Object.keys(safe).join(", "),
      });
      const album = {
        relPath: albumPath,
        name:
          meta?.title && String(meta.title).trim()
            ? String(meta.title).trim()
            : path.basename(albumPath),
        title: meta?.title ?? null,
        releaseDate: meta?.releaseDate ?? null,
        genre: meta?.genre ?? null,
        label: meta?.label ?? null,
        country: meta?.country ?? null,
        musicbrainzReleaseId: meta?.musicbrainzReleaseId ?? null,
        expectedTrackCount:
          typeof meta?.expectedTrackCount === "number"
            ? meta.expectedTrackCount
            : null,
        expectedTracks: Array.isArray(meta?.expectedTracks)
          ? meta.expectedTracks
          : null,
        hasAlbumMeta: true,
      };
      const trackPatches = touchedTracks.map((row) => ({
        relPath: row.relPath,
        meta: row.meta,
      }));
      const cachePatched =
        (await patchAlbumInLibraryIndexCache(root, albumPath, album)) ||
        (trackPatches.length
          ? await patchTracksInLibraryIndexCache(root, trackPatches)
          : false);
      scheduleLibraryIndexMetaRefresh(root, cachePatched);
      return sendOk(res, {
        albumPath,
        meta,
        album,
        tracks: touchedTracks,
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/track-info/fetch", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.body?.relPath || ""));
    if (!relPath) return sendError(res, 400, "relPath is required");
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
      const artist = parts[0] || "";
      const album = parts.length >= 3 ? parts[1] : "";
      const albumRel = albumFolderFromRelPath(relPath);
      if (!albumRel) return sendError(res, 400, "Invalid track path");
      const albumDir = path.join(root, albumRel.replaceAll("/", path.sep));
      if (!underRoot(albumDir, root) || !existsSync(albumDir))
        return sendError(res, 404, "Album folder not found");
      const titleRaw =
        String(fileName)
          .replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "")
          .trim() || fileName;
      const fpRead = existingAlbumTrackInfoPath(albumDir);
      let json = {};
      if (fpRead) {
        try {
          json = JSON.parse(await fs.readFile(fpRead, "utf8")) || {};
        } catch {
          json = {};
        }
      }
      const existingTr = json[fileName];
      const artistFromTrackInfo =
        existingTr &&
        typeof existingTr === "object" &&
        typeof existingTr.artist === "string"
          ? String(existingTr.artist).trim()
          : "";
      const artistForTitle = artistFromTrackInfo || artist;
      const title =
        prepareTrackTitleForMeta(artistForTitle, titleRaw) || titleRaw;
      const meta = await fetchTrackMetadata(
        artistForTitle,
        title,
        album,
        titleRaw
      );
      if (meta.error) return sendError(res, 404, meta.error);
      const row = await saveTrackFetchedMeta(albumDir, fileName, {
        ...meta,
        fetchedAt: new Date().toISOString(),
      });
      void actLog(req, {
        kind: "library",
        action: "track_metadata_fetch",
        folder: albumRel,
        detail: fileName,
      });
      const fileMs = await getAudioFileDurationMs(fullTrackPath);
      const metaOut = {
        ...row,
        durationMs: Number.isFinite(fileMs) ? fileMs : null,
      };
      const resolvedTitle =
        metaOut?.title && String(metaOut.title).trim()
          ? String(metaOut.title).trim()
          : null;
      const trackDelta = {
        relPath,
        ...(resolvedTitle ? { title: resolvedTitle } : {}),
        meta: metaOut,
      };
      const cachePatched = await patchTrackInLibraryIndexCache(
        root,
        relPath,
        trackDelta,
      );
      scheduleLibraryIndexMetaRefresh(root, cachePatched);
      return res.json({ ok: true, relPath, meta: metaOut, track: trackDelta });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/track-lyrics/fetch", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.body?.relPath || ""));
    if (!relPath) return sendError(res, 400, "relPath is required");
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
      const artistFolder = parts[0] || "";
      const albumFolder = parts.length >= 3 ? parts[1] : "";
      const albumRel = albumFolderFromRelPath(relPath);
      if (!albumRel) return sendError(res, 400, "Invalid track path");
      const albumDir = path.join(root, albumRel.replaceAll("/", path.sep));
      if (!underRoot(albumDir, root) || !existsSync(albumDir))
        return sendError(res, 404, "Album folder not found");
      const titleRaw =
        String(fileName)
          .replace(/\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i, "")
          .trim() || fileName;
      const fpRead = existingAlbumTrackInfoPath(albumDir);
      let json = {};
      if (fpRead) {
        try {
          json = JSON.parse(await fs.readFile(fpRead, "utf8")) || {};
        } catch {
          json = {};
        }
      }
      const existingTr = json[fileName];
      const artistFromTrackInfo =
        existingTr &&
        typeof existingTr === "object" &&
        typeof existingTr.artist === "string"
          ? String(existingTr.artist).trim()
          : "";
      const artist = artistFromTrackInfo || artistFolder;
      const title = prepareTrackTitleForMeta(artist, titleRaw) || titleRaw;
      const durMs = await getAudioFileDurationMs(fullTrackPath);
      const lyric = await fetchTrackLyricsLrcLib(
        artist,
        title,
        albumFolder,
        Number.isFinite(durMs) ? durMs : null,
      );
      if (lyric?.error) return sendError(res, 404, lyric.error);
      const synced = lyric?.syncedLyrics || null;
      const plain = lyric?.plainLyrics || null;
      void actLog(req, {
        kind: "library",
        action: "track_lyrics_fetch",
        folder: albumRel,
        detail: fileName,
      });
      return sendOk(res, {
        relPath,
        syncedLyrics: synced,
        plainLyrics: plain,
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/track-info/save", async (req, res) => {
    const root = getMusicRoot();
    const relPath = safeRelSeg(String(req.body?.relPath || ""));
    const patch = req.body?.patch;
    if (!relPath) return sendError(res, 400, "relPath is required");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return sendError(res, 400, "patch object is required");
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
      const albumDir = path.join(root, albumRel.replaceAll("/", path.sep));
      if (!underRoot(albumDir, root) || !existsSync(albumDir))
        return sendError(res, 404, "Album folder not found");
      const allowed = [
        "title",
        "releaseDate",
        "genre",
        "lyrics",
        "trackNumber",
        "discNumber",
        "source",
        "url",
      ];
      const safe = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) safe[k] = patch[k];
      }
      const hasMood =
        Object.prototype.hasOwnProperty.call(patch, "moods") ||
        Object.prototype.hasOwnProperty.call(patch, "mood");
      if (!Object.keys(safe).length && !hasMood) {
        return sendError(res, 400, "No valid fields in patch");
      }
      const accId = accountIdFromReq(req);
      let meta = {};
      if (Object.keys(safe).length) {
        meta = await saveTrackManualMeta(albumDir, fileName, safe);
      }
      let moods = [];
      if (hasMood) {
        const list = normalizeTrackMoodsList(
          Object.prototype.hasOwnProperty.call(patch, "moods")
            ? patch.moods
            : null,
          Object.prototype.hasOwnProperty.call(patch, "mood") ? patch.mood : null
        );
        const merged = await writeUserTrackMoodsWithCAS(root, accId, relPath, list);
        moods = merged.trackMoods?.[relPath] ?? [];
      }
      void actLog(req, {
        kind: "library",
        action: "track_metadata_save",
        folder: albumRel,
        detail: `${fileName}: ${Object.keys(safe).join(", ")}${
        hasMood ? ", moods" : ""
      }`,
      });
      const title =
        meta?.title && String(meta.title).trim()
          ? String(meta.title).trim()
          : patch?.title && String(patch.title).trim()
            ? String(patch.title).trim()
            : null;
      const metaOut = hasMood ? { ...meta, moods } : meta;
      const trackDelta = {
        relPath,
        ...(title ? { title } : {}),
        meta: metaOut,
      };
      const cachePatched = await patchTrackInLibraryIndexCache(
        root,
        relPath,
        trackDelta,
      );
      scheduleLibraryIndexMetaRefresh(root, cachePatched);
      return res.json({
        ok: true,
        relPath,
        meta: metaOut,
        track: trackDelta,
        album: { relPath: albumRel },
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/track-info/prune-orphans", async (req, res) => {
    const root = getMusicRoot();
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    if (!albumPath) return sendError(res, 400, "albumPath is required");
    try {
      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (!underRoot(full, root) || !existsSync(full)) {
        return sendError(res, 400, "Folder does not exist");
      }
      if (!statSync(full).isDirectory())
        return sendError(res, 400, "Not a directory");
      const r = await pruneOrphanTrackMetaInAlbumDir(full);
      if (r.removed.length) {
        void actLog(req, {
          kind: "library",
          action: "track_metadata_prune_orphans",
          folder: albumPath,
          detail: `${r.removed.length} key(s): ${r.removed
          .slice(0, 12)
          .join(", ")}${r.removed.length > 12 ? "…" : ""}`,
        });
        await invalidateLibraryIndex(root);
      }
      return sendOk(res, { albumPath, removed: r.removed, written: r.written });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/studio/sanitize-track-titles", async (req, res) => {
    const scope = String(req.body?.scope || "album");
    const dryRun = Boolean(req.body?.dryRun);
    const albumPath = safeRelSeg(String(req.body?.albumPath || ""));
    try {
      const root = getMusicRoot();
      if (scope === "all") {
        const data = await sanitizeTrackTitlesFullLibrary(root, dryRun);
        if (!dryRun && data.changes.length > 0) {
          const n = data.changes.length;
          void actLog(req, {
            kind: "studio",
            action: "sanitize_titles_library",
            folder: null,
            detail: `library (${n} file${n === 1 ? "" : "s"})`,
          });
          await invalidateLibraryIndex(root);
        }
        return sendOk(res, data);
      }
      if (!albumPath) {
        return sendError(res, 400, "albumPath is required for album scope");
      }
      const full = path.join(root, albumPath.replaceAll("/", path.sep));
      if (
        !underRoot(full, root) ||
        !existsSync(full) ||
        !statSync(full).isDirectory()
      ) {
        return sendError(res, 400, "Invalid album folder");
      }
      const r = await sanitizeTrackTitlesInAlbumDir(full, dryRun);
      if (!dryRun && r.changes.length > 0) {
        const n = r.changes.length;
        void actLog(req, {
          kind: "studio",
          action: "sanitize_titles_album",
          folder: albumPath,
          detail: `album (${n} file${n === 1 ? "" : "s"})`,
        });
        await invalidateLibraryIndex(root);
      }
      return sendOk(res, { ...r, albumPath });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

}
