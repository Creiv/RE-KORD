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
import { runLibraryScan, scheduleLibraryScan } from "./scanner/index.mjs"
import { startLibraryWatcher } from "./scanner/watcher.mjs"

/** Evita bootstrap/scan duplicate in parallelo. */
const libraryIndexFlight = new Map()

export async function getLibraryIndex(root = getMusicRoot()) {
  if (!existsSync(root) || !underRoot(root, root)) {
    throw new Error("Music library folder is not available")
  }
  const key = path.resolve(root)
  let inflight = libraryIndexFlight.get(key)
  if (inflight) return inflight

  inflight = (async () => {
    const created = await bootstrapLibraryDb(root)
    if (created) {
      console.log(`[rekord] library database bootstrapped at ${root}/.kord/rekord.db`)
    }
    await backfillMissingArtworkCache(root)
    startLibraryWatcher(root)
    return buildLibraryIndexFromDb(root)
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

export function searchLibraryIndex(index, query) {
  const q = String(query || "").trim()
  if (!q) return { artists: [], albums: [], tracks: [] }
  if (index?.musicRoot && process.env.REKORD_DB_SEARCH !== "0") {
    try {
      return searchLibraryDb(index.musicRoot, q)
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
