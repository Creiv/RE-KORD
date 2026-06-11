/**
 * Indice libreria: cache + dedup richieste parallele, viste filtrate per account,
 * overview/dettagli/ricerca. Estratto da index.mjs (Fase 6).
 */
import path from "path";
import { existsSync } from "fs";
import { getMusicRoot } from "./musicRootConfig.mjs";
import { underRoot } from "./pathSafety.mjs";
import { buildLibraryIndex } from "./musicLibrary.mjs";
import { readUserState } from "./userState.mjs";
import {
  filterLibraryIndexBySelection,
  mergeTrackMoodsIntoIndex,
  mergePlectrBestsIntoIndex,
  readLibrarySelection,
} from "./librarySelection.mjs";
import {
  readLibraryIndexCache,
  writeLibraryIndexCache,
  scheduleBackgroundLibraryRefresh,
  invalidateLibraryIndexCache,
  getLibraryIndexCacheEpochSnapshot,
} from "./libraryIndexCache.mjs";

/** Evita scan disco duplicate quando più richieste parallele leggono lo stesso root (es. /api/library-index + /api/dashboard all'avvio UI). */
const libraryIndexFlight = new Map();
export async function getLibraryIndex(root = getMusicRoot()) {
  if (!existsSync(root) || !underRoot(root, root)) {
    throw new Error("Music library folder is not available");
  }
  const key = path.resolve(root);
  let inflight = libraryIndexFlight.get(key);
  if (inflight) return inflight;

  const cached = await readLibraryIndexCache(root);
  if (cached) {
    scheduleBackgroundLibraryRefresh(root);
    return cached;
  }

  inflight = (async () => {
    const epochAtStart = getLibraryIndexCacheEpochSnapshot(root);
    const idx = await buildLibraryIndex(root);
    if (getLibraryIndexCacheEpochSnapshot(root) === epochAtStart) {
      await writeLibraryIndexCache(root, idx);
    }
    return idx;
  })();
  libraryIndexFlight.set(key, inflight);
  inflight.finally(() => {
    if (libraryIndexFlight.get(key) === inflight) {
      libraryIndexFlight.delete(key);
    }
  });
  return inflight;
}

export async function invalidateLibraryIndex(root = getMusicRoot()) {
  libraryIndexFlight.delete(path.resolve(root));
  await invalidateLibraryIndexCache(root);
}

/** Metadati/copertina: patch cache se possibile; refresh completo solo se la patch non è andata a buon fine. */
export function scheduleLibraryIndexMetaRefresh(root, cachePatched) {
  if (!cachePatched) scheduleBackgroundLibraryRefresh(root);
}

export function albumDeltaFromMeta(albumPath, meta, albumNameFallback) {
  const title =
    meta?.title && String(meta.title).trim()
      ? String(meta.title).trim()
      : albumNameFallback || path.basename(albumPath);
  return {
    relPath: albumPath,
    name: title,
    title: meta?.title ?? null,
    releaseDate: meta?.releaseDate ?? null,
    genre: meta?.genre ?? null,
    label: meta?.label ?? null,
    country: meta?.country ?? null,
    musicbrainzReleaseId: meta?.musicbrainzReleaseId ?? null,
    hasAlbumMeta: true,
  };
}

export async function getFilteredIndexForAccount(accountId) {
  const root = getMusicRoot();
  const [full, state, sel] = await Promise.all([
    getLibraryIndex(root),
    readUserState(root, accountId),
    readLibrarySelection(root, accountId),
  ]);
  const filt = filterLibraryIndexBySelection(full, sel, accountId);
  const merged = mergePlectrBestsIntoIndex(
    mergeTrackMoodsIntoIndex(filt, state.trackMoods),
    state.plectrBests,
  );
  return {
    ...merged,
    indexEpoch: getLibraryIndexCacheEpochSnapshot(root),
  };
}

export function libraryOverviewFromIndex(index) {
  return {
    musicRoot: index.musicRoot || "",
    artists: index.artists,
    stats: index.stats,
  };
}

export function libraryArtistDetailFromIndex(index, artistId) {
  const artist = index.artists.find((a) => a.id === artistId || a.name === artistId);
  if (!artist) return null;
  const albumIds = new Set(artist.albums || []);
  const albums = index.albums.filter((album) => albumIds.has(album.id));
  const trackRelPaths = new Set(albums.flatMap((album) => album.tracks || []));
  const tracks = index.tracks.filter((track) => trackRelPaths.has(track.relPath));
  return { artist, albums, tracks };
}

export function libraryAlbumDetailFromIndex(index, relPathOrId) {
  const key = String(relPathOrId || "").trim();
  const album = index.albums.find(
    (item) => item.relPath === key || item.id === key || item.name === key,
  );
  if (!album) return null;
  const rels = new Set(album.tracks || []);
  const tracks = index.tracks.filter((track) => rels.has(track.relPath));
  return { album, tracks };
}

export function searchLibraryIndex(index, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { artists: [], albums: [], tracks: [] };
  const trackGenreIncludes = (track) => String(track?.meta?.genre || "").toLowerCase().includes(q);
  const artists = index.artists
    .filter((artist) => {
      if (String(artist.name || "").toLowerCase().includes(q)) return true;
      return index.tracks.some((track) => track.artist === artist.name && trackGenreIncludes(track));
    })
    .slice(0, 50);
  const albums = index.albums
    .filter((album) => {
      if (String(album.name || "").toLowerCase().includes(q)) return true;
      if (String(album.artist || "").toLowerCase().includes(q)) return true;
      return (album.tracks || []).some((rel) => {
        const track = index.tracks.find((item) => item.relPath === rel);
        return trackGenreIncludes(track);
      });
    })
    .slice(0, 80);
  const tracks = index.tracks
    .filter((track) => {
      return (
        String(track.title || "").toLowerCase().includes(q) ||
        String(track.artist || "").toLowerCase().includes(q) ||
        String(track.album || "").toLowerCase().includes(q) ||
        trackGenreIncludes(track)
      );
    })
    .slice(0, 150);
  return { artists, albums, tracks };
}
