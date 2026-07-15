/**
 * Indice libreria: SQLite come source of truth operativo.
 * Mantiene la stessa API di libraryIndexService per compatibilità UI.
 */
import path from "path"
import { existsSync } from "fs"
import { getMusicRoot } from "./musicRootConfig.mjs"
import { underRoot } from "./pathSafety.mjs"
import { readUserState } from "./userState.mjs"
import {
  filterLibraryIndexBySelection,
  mergeTrackMoodsIntoIndex,
  mergePlectrBestsIntoIndex,
  readLibrarySelection,
} from "./librarySelection.mjs"
import { bootstrapLibraryDb } from "./db/bootstrap.mjs"
import { getLibraryEpoch } from "./db/index.mjs"
import {
  buildLibraryIndexFromDb,
  searchLibraryDb,
  backfillMissingArtworkCache,
} from "./db/queries/library.mjs"
import { scheduleLibraryScan } from "./scanner/index.mjs"
import { startLibraryWatcher } from "./scanner/watcher.mjs"
import { backfillArtworkThumbs } from "./artwork/index.mjs"

/** Evita bootstrap/scan duplicate in parallelo. */
const libraryIndexFlight = new Map()

/** Cache in-memory per root: rebuild solo quando epoch cambia. */
const libraryIndexMemoryCache = new Map()

/** Side-effect bootstrap (watcher, backfill) una volta per root per processo. */
const bootstrapSideEffectsStarted = new Set()

/** Backfill thumb: una sola volta per root per processo, in background. */
const thumbBackfillStarted = new Set()

/** Backfill artwork cache: una sola volta per root per processo, in background. */
const artworkBackfillStarted = new Set()

export function clearLibraryIndexCache(root = getMusicRoot()) {
  libraryIndexMemoryCache.delete(path.resolve(root))
}

function startArtworkThumbBackfill(root) {
  const key = path.resolve(root)
  if (thumbBackfillStarted.has(key)) return
  thumbBackfillStarted.add(key)
  void backfillArtworkThumbs(key)
    .then(({ updated }) => {
      if (updated > 0) {
        console.log(`[rekord] artwork thumbs backfilled: ${updated}`)
      }
    })
    .catch((error) => {
      console.warn(
        "[rekord] artwork thumb backfill failed:",
        error?.message || error,
      )
    })
}

function startMissingArtworkBackfill(root) {
  const key = path.resolve(root)
  if (artworkBackfillStarted.has(key)) return
  artworkBackfillStarted.add(key)
  void backfillMissingArtworkCache(root).catch((error) => {
    console.warn(
      "[rekord] artwork cache backfill failed:",
      error?.message || error,
    )
  })
}

async function ensureBootstrapSideEffects(root) {
  const key = path.resolve(root)
  if (bootstrapSideEffectsStarted.has(key)) return
  bootstrapSideEffectsStarted.add(key)
  const created = await bootstrapLibraryDb(root)
  if (created) {
    console.log(`[rekord] library database bootstrapped at ${root}/.kord/rekord.db`)
  }
  startMissingArtworkBackfill(root)
  startArtworkThumbBackfill(root)
  startLibraryWatcher(root)
}

function readCachedIndex(root) {
  const key = path.resolve(root)
  const cached = libraryIndexMemoryCache.get(key)
  if (!cached) return null
  try {
    const epoch = getLibraryEpoch(root)
    if (cached.epoch === epoch) return cached.index
  } catch {
    return null
  }
  libraryIndexMemoryCache.delete(key)
  return null
}

function storeCachedIndex(root, index) {
  const key = path.resolve(root)
  try {
    const epoch = getLibraryEpoch(root)
    libraryIndexMemoryCache.set(key, { epoch, index })
  } catch {
    /* DB non pronto */
  }
}

export async function getLibraryIndex(root = getMusicRoot()) {
  if (!existsSync(root) || !underRoot(root, root)) {
    throw new Error("Music library folder is not available")
  }
  const key = path.resolve(root)

  const cached = readCachedIndex(root)
  if (cached) return cached

  let inflight = libraryIndexFlight.get(key)
  if (inflight) return inflight

  inflight = (async () => {
    const hit = readCachedIndex(root)
    if (hit) return hit
    await ensureBootstrapSideEffects(root)
    const index = buildLibraryIndexFromDb(root)
    storeCachedIndex(root, index)
    return index
  })()

  libraryIndexFlight.set(key, inflight)
  inflight.finally(() => {
    if (libraryIndexFlight.get(key) === inflight) {
      libraryIndexFlight.delete(key)
    }
  })
  return inflight
}

export async function invalidateLibraryIndex(root = getMusicRoot()) {
  clearLibraryIndexCache(root)
  libraryIndexFlight.delete(path.resolve(root))
  scheduleLibraryScan(root, { debounceMs: 200 })
}

/** Metadati/copertina: rescan mirato se la patch DB non basta. */
export function scheduleLibraryIndexMetaRefresh(root, cachePatched) {
  if (!cachePatched) scheduleLibraryScan(root, { debounceMs: 400 })
}

export function albumDeltaFromMeta(albumPath, meta, albumNameFallback) {
  const title =
    meta?.title && String(meta.title).trim()
      ? String(meta.title).trim()
      : albumNameFallback || path.basename(albumPath)
  return {
    relPath: albumPath,
    name: title,
    title: meta?.title ?? null,
    releaseDate: meta?.releaseDate ?? null,
    genre: meta?.genre ?? null,
    label: meta?.label ?? null,
    country: meta?.country ?? null,
    musicbrainzReleaseId: meta?.musicbrainzReleaseId ?? null,
    discogsReleaseId: meta?.discogsReleaseId ?? null,
    discogsUri: meta?.discogsUri ?? meta?.discogsExtra?.discogsUri ?? null,
    discogsExtra: meta?.discogsExtra ?? null,
    hasAlbumMeta: true,
  }
}

export async function getFilteredIndexForAccount(accountId) {
  const root = getMusicRoot()
  const [full, state, sel] = await Promise.all([
    getLibraryIndex(root),
    readUserState(root, accountId),
    readLibrarySelection(root, accountId),
  ])
  const filt = filterLibraryIndexBySelection(full, sel, accountId)
  const merged = mergePlectrBestsIntoIndex(
    mergeTrackMoodsIntoIndex(filt, state.trackMoods),
    state.plectrBests,
  )
  return {
    ...merged,
    indexEpoch: getLibraryEpoch(root),
  }
}

export function libraryOverviewFromIndex(index) {
  return {
    musicRoot: index.musicRoot || "",
    artists: index.artists,
    stats: index.stats,
  }
}

export function libraryArtistDetailFromIndex(index, artistId) {
  const artist = index.artists.find((a) => a.id === artistId || a.name === artistId)
  if (!artist) return null
  const albumIds = new Set(artist.albums || [])
  const albums = index.albums.filter((album) => albumIds.has(album.id))
  const trackRelPaths = new Set(albums.flatMap((album) => album.tracks || []))
  const tracks = index.tracks.filter((track) => trackRelPaths.has(track.relPath))
  return { artist, albums, tracks }
}

export function libraryAlbumDetailFromIndex(index, relPathOrId) {
  const key = String(relPathOrId || "").trim()
  const album = index.albums.find(
    (item) => item.relPath === key || item.id === key || item.name === key,
  )
  if (!album) return null
  const tracks = (album.tracks || [])
    .map((relPath) => index.tracks.find((track) => track.relPath === relPath))
    .filter(Boolean)
  return { album, tracks }
}

/** Restringe risultati ricerca DB al sotto-insieme già filtrato per account/selezione. */
function filterSearchResultsToIndex(index, results) {
  const artistIds = new Set(index.artists.map((a) => a.id))
  const artistNames = new Set(index.artists.map((a) => a.name))
  const albumPaths = new Set(index.albums.map((a) => a.relPath))
  const trackPaths = new Set(index.tracks.map((t) => t.relPath))
  return {
    artists: results.artists.filter(
      (a) => artistIds.has(a.id) || artistNames.has(a.name),
    ),
    albums: results.albums.filter((a) => albumPaths.has(a.relPath)),
    tracks: results.tracks.filter((t) => trackPaths.has(t.relPath)),
  }
}

export function searchLibraryIndex(index, query) {
  const q = String(query || "").trim()
  if (!q) return { artists: [], albums: [], tracks: [] }
  if (index?.musicRoot && process.env.REKORD_DB_SEARCH !== "0") {
    try {
      return filterSearchResultsToIndex(index, searchLibraryDb(index.musicRoot, q))
    } catch {
      /* fallback sotto */
    }
  }
  const ql = q.toLowerCase()
  const trackGenreIncludes = (track) =>
    String(track?.meta?.genre || "")
      .toLowerCase()
      .includes(ql)
  const artists = index.artists
    .filter((artist) => {
      if (String(artist.name || "").toLowerCase().includes(ql)) return true
      return index.tracks.some(
        (track) => track.artist === artist.name && trackGenreIncludes(track),
      )
    })
    .slice(0, 50)
  const albums = index.albums
    .filter((album) => {
      if (String(album.name || "").toLowerCase().includes(ql)) return true
      if (String(album.artist || "").toLowerCase().includes(ql)) return true
      return (album.tracks || []).some((rel) => {
        const track = index.tracks.find((item) => item.relPath === rel)
        return trackGenreIncludes(track)
      })
    })
    .slice(0, 80)
  const tracks = index.tracks
    .filter((track) => {
      return (
        String(track.title || "").toLowerCase().includes(ql) ||
        String(track.artist || "").toLowerCase().includes(ql) ||
        String(track.album || "").toLowerCase().includes(ql) ||
        trackGenreIncludes(track)
      )
    })
    .slice(0, 150)
  return { artists, albums, tracks }
}

export function getLibraryIndexCacheEpochSnapshot(root = getMusicRoot()) {
  try {
    return getLibraryEpoch(root)
  } catch {
    return 0
  }
}

/** Reset stato in-memory per un root (es. cambio musicRoot). */
export function resetLibraryIndexServiceStateForRoot(root) {
  if (!root) return
  const key = path.resolve(String(root))
  libraryIndexFlight.delete(key)
  libraryIndexMemoryCache.delete(key)
  bootstrapSideEffectsStarted.delete(key)
  thumbBackfillStarted.delete(key)
  artworkBackfillStarted.delete(key)
}

/** Solo test: reset stato modulo. */
export function resetLibraryIndexServiceStateForTests() {
  libraryIndexFlight.clear()
  libraryIndexMemoryCache.clear()
  bootstrapSideEffectsStarted.clear()
  thumbBackfillStarted.clear()
  artworkBackfillStarted.clear()
}
