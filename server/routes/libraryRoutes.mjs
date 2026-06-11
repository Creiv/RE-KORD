/**
 * Libreria: indice, overview, dettagli, ricerca, selezione per account.
 * Estratto da index.mjs (Fase 6).
 */
import { accountIdFromReq, sendError, sendOk } from "../httpUtils.mjs";
import {
  getFilteredIndexForAccount,
  getLibraryIndex,
  libraryAlbumDetailFromIndex,
  libraryArtistDetailFromIndex,
  libraryOverviewFromIndex,
  searchLibraryIndex,
} from "../libraryIndexService.mjs";
import {
  readLibrarySelection,
  removeAlbumsFromSelectionSets,
  sanitizeLibrarySelection,
  sanitizeRelPathForSelection,
  writeLibrarySelection,
} from "../librarySelection.mjs";
import { toLegacyLibrary } from "../musicLibrary.mjs";
import {
  findAccountById,
  getDefaultAccountId,
  getMusicRoot,
  getMusicRootForAccountStrict,
} from "../musicRootConfig.mjs";

export function registerLibraryRoutes(app) {
  app.get("/api/library", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      return sendOk(res, toLegacyLibrary(index));
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/library-index", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, index);
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/library-overview", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, libraryOverviewFromIndex(index));
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/library-artists/:id", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      const id = decodeURIComponent(String(req.params.id || ""));
      const detail = libraryArtistDetailFromIndex(index, id);
      if (!detail) return sendError(res, 404, "Artist not found");
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, detail);
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/library-albums", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      const key = String(req.query.relPath || req.query.id || req.query.album || "").trim();
      const detail = libraryAlbumDetailFromIndex(index, key);
      if (!detail) return sendError(res, 404, "Album not found");
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, detail);
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/library-search", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, searchLibraryIndex(index, req.query.q));
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/library/tracks/resolve", async (req, res) => {
    try {
      const accountId = accountIdFromReq(req);
      const index = await getFilteredIndexForAccount(accountId);
      const rels = Array.isArray(req.body?.relPaths)
        ? req.body.relPaths.map((item) => String(item || "")).filter(Boolean)
        : [];
      const wanted = new Set(rels);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, { tracks: index.tracks.filter((track) => wanted.has(track.relPath)) });
    } catch (error) {
      console.error(error);
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/my-library-selection", async (req, res) => {
    try {
      const root = getMusicRoot();
      const accountId = accountIdFromReq(req);
      let cur = await readLibrarySelection(root, accountId);
      if (!cur) {
        cur = sanitizeLibrarySelection(
          accountId === getDefaultAccountId()
            ? { includeAll: true }
            : { includeAll: false }
        );
      }
      return sendOk(res, cur);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.patch("/api/my-library-selection", async (req, res) => {
    try {
      const root = getMusicRoot();
      const accountId = accountIdFromReq(req);
      const full = await getLibraryIndex(root);
      const artistSet = new Set(full.artists.map((a) => a.id));
      const albumPathSet = new Set(full.albums.map((a) => a.relPath));

      let cur = await readLibrarySelection(root, accountId);
      if (!cur) {
        cur = sanitizeLibrarySelection(
          accountId === getDefaultAccountId()
            ? { includeAll: true }
            : { includeAll: false }
        );
      }

      const body = req.body || {};
      if (body.includeAll === true) {
        cur = sanitizeLibrarySelection({
          includeAll: true,
          artists: [],
          albums: [],
          tracks: [],
        });
      } else if (body.includeAll === false) {
        cur = sanitizeLibrarySelection({ ...cur, includeAll: false });
      }

      if (!cur.includeAll) {
        const artists = new Set(cur.artists);
        const albums = new Set(cur.albums);
        const tracks = new Set(cur.tracks);

        for (const a of Array.isArray(body.addArtists) ? body.addArtists : []) {
          const id = typeof a === "string" ? a.trim() : "";
          if (id && artistSet.has(id)) artists.add(id);
        }
        for (const a of Array.isArray(body.removeArtists)
          ? body.removeArtists
          : []) {
          const id = typeof a === "string" ? a.trim() : "";
          if (id) artists.delete(id);
        }
        for (const raw of Array.isArray(body.addAlbums) ? body.addAlbums : []) {
          const rel = sanitizeRelPathForSelection(String(raw || ""));
          if (rel && albumPathSet.has(rel)) albums.add(rel);
        }
        removeAlbumsFromSelectionSets(full, artists, albums, body.removeAlbums);
        for (const raw of Array.isArray(body.addTracks) ? body.addTracks : []) {
          const rel = sanitizeRelPathForSelection(String(raw || ""));
          if (rel) tracks.add(rel);
        }
        for (const raw of Array.isArray(body.removeTracks)
          ? body.removeTracks
          : []) {
          const rel = sanitizeRelPathForSelection(String(raw || ""));
          if (rel) tracks.delete(rel);
        }

        cur = sanitizeLibrarySelection({
          includeAll: false,
          artists: [...artists],
          albums: [...albums],
          tracks: [...tracks],
        });
      }

      const saved = await writeLibrarySelection(root, accountId, cur);
      return sendOk(res, saved);
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.get("/api/accounts/:id/library-index", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id || !findAccountById(id)) {
        return sendError(res, 404, "Account not found");
      }
      getMusicRootForAccountStrict(id);
      const index = await getFilteredIndexForAccount(id);
      res.set("Cache-Control", "no-store, must-revalidate");
      return sendOk(res, index);
    } catch (error) {
      console.error(error);
      if (error?.code === "ACCOUNT_NOT_FOUND") {
        return sendError(res, 404, String(error.message || error));
      }
      return sendError(res, 500, String(error?.message || error));
    }
  });

}
