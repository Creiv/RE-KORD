import fs from "fs/promises"
import { existsSync, statSync } from "fs"
import { stat as statAsync } from "fs/promises"
import path from "path"
import { loadAlbumJsonMetaFromDir, loadTrackJsonMetaMapFromDir } from "./albumInfo.mjs"
import { orderAlbumTrackList } from "./albumExpectedOrder.mjs"
import { getAudioFileDurationMs } from "./audioDuration.mjs"
import { parseTrackGenres } from "./genres.mjs"
import { readAudioTags } from "./audioTags.mjs"
import {
  classifyFolderNode,
  DEFAULT_LAYOUT_CONFIG,
  layoutAlbumFolderName,
  LOOSE_ALBUM_FOLDER,
  loadLibraryLayout,
  resolveTrackIdentity,
} from "./libraryLayout.mjs"

const AUDIO = /\.(mp3|flac|m4a|ogg|opus|wav|aac|webm)$/i
export const LIBRARY_EXCLUDE = new Set([
  "kord",
  "node_modules",
  ".git",
  ".trash",
  ".wpp",
  ".rekord",
])
const EXCLUDE = LIBRARY_EXCLUDE
const COVER_FILES = [
  "cover.jpg",
  "folder.jpg",
  "front.jpg",
  "cover.png",
  "folder.png",
  "artwork.jpg",
]

/** Copertine album salvate in libreria (backup/restore metadati visivi). */
export const ALBUM_COVER_BASENAMES = COVER_FILES

function numOrNull(v) {
  return Number.isFinite(v) ? Number(v) : null
}

function cmpByDateThenName(ax, bx) {
  const da = String(ax?.releaseDate || ax?.meta?.releaseDate || "")
  const db = String(bx?.releaseDate || bx?.meta?.releaseDate || "")
  if (!da && !db) {
    return String(ax?.name || ax?.title || "").localeCompare(
      String(bx?.name || bx?.title || ""),
      undefined,
      { numeric: true },
    )
  }
  if (!da) return 1
  if (!db) return -1
  const dcmp = da.localeCompare(db, undefined, { numeric: true })
  if (dcmp !== 0) return dcmp
  return String(ax?.name || ax?.title || "").localeCompare(
    String(bx?.name || bx?.title || ""),
    undefined,
    { numeric: true },
  )
}

function hasAudio(name) {
  return AUDIO.test(name)
}

export function trackHasFileMeta(t) {
  return Boolean(
    (t?.meta?.genre && parseTrackGenres(t.meta.genre).length > 0) ||
      t?.meta?.releaseDate,
  )
}

export function relify(parts) {
  return parts.filter(Boolean).join("/").replaceAll(path.sep, "/")
}

export function albumKey(artistName, albumName) {
  return `${artistName}::${albumName}`
}

export function trackFromFile({
  artistName,
  albumFolderName,
  albumDisplayName,
  fileName,
  fullPath,
  trackMeta,
  fileDurationMs,
  albumMeta,
  loose,
  enrichDuration = true,
  existingDurationMs = null,
  readTags = false,
  tagData = null,
}) {
  const filePath = loose
    ? relify([artistName, fileName])
    : relify([artistName, albumFolderName, fileName])
  const relPath = loose
    ? relify([artistName, layoutAlbumFolderName(LOOSE_ALBUM_FOLDER, true), fileName])
    : filePath
  const fromFile = fileName.replace(AUDIO, "").trim() || fileName
  const tOverride =
    trackMeta?.title && String(trackMeta.title).trim()
      ? String(trackMeta.title).trim()
      : null
  let title = tOverride || fromFile
  if (tagData?.title && !tOverride) title = tagData.title

  const st = statSync(fullPath)
  const trackNumberGuess = fromFile.match(/^\d{1,2}/)
  let durationMs = null
  if (enrichDuration) {
    durationMs = numOrNull(tagData?.durationMs ?? fileDurationMs)
  } else if (existingDurationMs != null) {
    durationMs = numOrNull(existingDurationMs)
  } else {
    durationMs = numOrNull(fileDurationMs)
  }

  return {
    id: relPath,
    title,
    relPath,
    filePath,
    albumFolderRelPath: loose
      ? relify([artistName])
      : relify([artistName, albumFolderName]),
    artist: tagData?.artist || artistName,
    album: albumDisplayName || albumFolderName,
    albumId: albumKey(artistName, albumFolderName),
    meta: {
      fileName,
      size: numOrNull(st.size),
      mtime: numOrNull(st.mtimeMs),
      releaseDate: trackMeta?.releaseDate || tagData?.releaseDate || null,
      genre: trackMeta?.genre || tagData?.genre || null,
      lyrics:
        trackMeta?.lyrics != null && String(trackMeta.lyrics).trim()
          ? String(trackMeta.lyrics).trim()
          : null,
      lyricsAutoChecked: Boolean(trackMeta?.lyricsAutoChecked),
      moods: [],
      durationMs,
      trackNumber: numOrNull(
        trackMeta?.trackNumber ||
          tagData?.trackNumber ||
          (trackNumberGuess ? Number(trackNumberGuess[0]) : null),
      ),
      discNumber: numOrNull(trackMeta?.discNumber),
      source: trackMeta?.source || null,
      url: trackMeta?.url || null,
    },
    ...(albumMeta ? { albumMeta } : {}),
    loose: Boolean(loose),
    addedAt: numOrNull(st.birthtimeMs || st.ctimeMs || st.mtimeMs),
    updatedAt: numOrNull(st.mtimeMs),
  }
}

function getCoverForAlbumDir(albumDir, albumRelPath) {
  for (const name of COVER_FILES) {
    const full = path.join(albumDir, name)
    if (existsSync(full)) {
      return `${albumRelPath}/${name}`.replaceAll(path.sep, "/")
    }
  }
  return null
}

async function entryIsAudioInDir(entry, dir) {
  if (!hasAudio(entry.name)) return false
  if (entry.isFile()) return true
  if (entry.isSymbolicLink()) {
    try {
      const st = await statAsync(path.join(dir, entry.name))
      return st.isFile()
    } catch {
      return false
    }
  }
  return false
}

async function resolveTrackFileMeta(fullPath, opts = {}) {
  let tagData = null
  let fileDurationMs = null
  if (opts.readTags) {
    tagData = await readAudioTags(fullPath)
  }
  if (opts.enrichDuration !== false) {
    if (tagData?.durationMs != null) {
      fileDurationMs = tagData.durationMs
    } else {
      fileDurationMs = await getAudioFileDurationMs(fullPath)
    }
  }
  return { tagData, fileDurationMs }
}

export async function readAlbumTracks(
  artistName,
  albumFolderName,
  albumDir,
  albumMeta,
  opts = {},
) {
  const albumDisplayName =
    albumMeta?.title && String(albumMeta.title).trim()
      ? String(albumMeta.title).trim()
      : albumFolderName
  const trackMetaMap = await loadTrackJsonMetaMapFromDir(albumDir)
  const entries = await fs.readdir(albumDir, { withFileTypes: true })
  const existingByFile = opts.existingDurations || null
  const tracks = []
  for (const entry of entries) {
    if (!(await entryIsAudioInDir(entry, albumDir))) continue
    const fullPath = path.join(albumDir, entry.name)
    const filePath = relify([artistName, albumFolderName, entry.name])
    const { tagData, fileDurationMs } = await resolveTrackFileMeta(fullPath, opts)
    tracks.push(
      trackFromFile({
        artistName,
        albumFolderName,
        albumDisplayName,
        fileName: entry.name,
        fullPath,
        trackMeta: trackMetaMap?.[entry.name] || null,
        fileDurationMs,
        tagData,
        albumMeta,
        enrichDuration: opts.enrichDuration !== false,
        existingDurationMs: existingByFile?.get(filePath) ?? null,
        readTags: Boolean(opts.readTags),
      }),
    )
  }
  return orderAlbumTrackList(tracks)
}

export async function readLooseTracks(artistName, artistDir, opts = {}) {
  const entries = await fs.readdir(artistDir, { withFileTypes: true })
  const existingByFile = opts.existingDurations || null
  const tracks = []
  for (const entry of entries) {
    if (!(await entryIsAudioInDir(entry, artistDir))) continue
    const fullPath = path.join(artistDir, entry.name)
    const filePath = relify([artistName, entry.name])
    const { tagData, fileDurationMs } = await resolveTrackFileMeta(fullPath, opts)
    tracks.push(
      trackFromFile({
        artistName,
        albumFolderName: LOOSE_ALBUM_FOLDER,
        albumDisplayName: LOOSE_ALBUM_FOLDER,
        fileName: entry.name,
        fullPath,
        trackMeta: null,
        fileDurationMs,
        tagData,
        albumMeta: null,
        loose: true,
        enrichDuration: opts.enrichDuration !== false,
        existingDurationMs: existingByFile?.get(filePath) ?? null,
        readTags: Boolean(opts.readTags),
      }),
    )
  }
  tracks.sort((a, b) => cmpByDateThenName(a, b))
  return tracks
}

function buildAlbumItem({
  artistName,
  albumFolderName,
  albumDisplayName,
  albumDir,
  albumTracks,
  albumMeta,
  loose,
}) {
  const albumRelPath = loose
    ? relify([artistName])
    : relify([artistName, albumFolderName])
  const st = statSync(albumDir)
  const coverRelPath = loose ? null : getCoverForAlbumDir(albumDir, albumRelPath)
  return {
    id: albumKey(artistName, loose ? LOOSE_ALBUM_FOLDER : albumFolderName),
    artistId: artistName,
    artist: artistName,
    name: albumDisplayName,
    relPath: albumRelPath,
    trackCount: albumTracks.length,
    coverRelPath,
    title: albumMeta?.title || null,
    releaseDate: albumMeta?.releaseDate || null,
    genre: albumMeta?.genre || null,
    label: albumMeta?.label || null,
    country: albumMeta?.country || null,
    musicbrainzReleaseId: albumMeta?.musicbrainzReleaseId || null,
    discogsReleaseId: albumMeta?.discogsReleaseId ?? null,
    discogsUri: albumMeta?.discogsUri ?? null,
    discogsExtra: albumMeta?.discogsExtra ?? null,
    expectedTrackCount:
      typeof albumMeta?.expectedTrackCount === "number"
        ? albumMeta.expectedTrackCount
        : Array.isArray(albumMeta?.expectedTracks)
          ? albumMeta.expectedTracks.length
          : null,
    expectedTracks: Array.isArray(albumMeta?.expectedTracks)
      ? albumMeta.expectedTracks
      : null,
    hasCover: Boolean(coverRelPath),
    hasAlbumMeta: Boolean(albumMeta),
    hasTrackMeta: albumTracks.some(trackHasFileMeta),
    tracksWithoutFileMetaCount: albumTracks.filter((track) => !trackHasFileMeta(track)).length,
    loose: Boolean(loose),
    addedAt: numOrNull(st.birthtimeMs || st.ctimeMs || st.mtimeMs),
    updatedAt: numOrNull(st.mtimeMs),
    tracks: albumTracks.map((track) => track.relPath),
  }
}

async function buildArtistBranch(artistName, artistDir, opts = {}) {
  const subs = await fs.readdir(artistDir, { withFileTypes: true })
  const artistAlbums = []
  const allTracks = []
  const artistLooseTracks = await readLooseTracks(artistName, artistDir, opts)

  for (const sub of subs) {
    if (!sub.isDirectory() || sub.name.startsWith(".")) continue
    const albumDir = path.join(artistDir, sub.name)
    const albumMeta = await loadAlbumJsonMetaFromDir(albumDir)
    const albumDisplayName =
      albumMeta?.title && String(albumMeta.title).trim()
        ? String(albumMeta.title).trim()
        : sub.name
    const albumTracks = await readAlbumTracks(
      artistName,
      sub.name,
      albumDir,
      albumMeta,
      opts,
    )
    if (!albumTracks.length) continue
    const albumItem = buildAlbumItem({
      artistName,
      albumFolderName: sub.name,
      albumDisplayName,
      albumDir,
      albumTracks,
      albumMeta,
      loose: false,
    })
    artistAlbums.push(albumItem)
    allTracks.push(...albumTracks)
  }

  if (artistLooseTracks.length) {
    const looseAlbum = buildAlbumItem({
      artistName,
      albumFolderName: LOOSE_ALBUM_FOLDER,
      albumDisplayName: LOOSE_ALBUM_FOLDER,
      albumDir: artistDir,
      albumTracks: artistLooseTracks,
      albumMeta: null,
      loose: true,
    })
    artistAlbums.unshift(looseAlbum)
    allTracks.push(...artistLooseTracks)
  }

  artistAlbums.sort((a, b) => cmpByDateThenName(a, b))
  if (!artistAlbums.length) return null

  const albumsWithoutFileMetaCount = artistAlbums.filter(
    (a) => !a.loose && !a.hasAlbumMeta,
  ).length
  const tracksWithoutFileMetaCount = artistAlbums.reduce(
    (sum, a) => sum + (a.tracksWithoutFileMetaCount || 0),
    0,
  )
  return {
    artist: {
      id: artistName,
      name: artistName,
      albumCount: artistAlbums.length,
      trackCount: artistAlbums.reduce((sum, album) => sum + album.trackCount, 0),
      releaseDate: artistAlbums[0]?.releaseDate || null,
      coverRelPath: artistAlbums.find((album) => album.coverRelPath)?.coverRelPath || null,
      albums: artistAlbums.map((album) => album.id),
      albumsWithoutFileMetaCount,
      tracksWithoutFileMetaCount,
    },
    albums: artistAlbums,
    tracks: allTracks,
  }
}

async function buildFlatTracksAtRoot(musicRoot, layout, opts = {}) {
  const entries = await fs.readdir(musicRoot, { withFileTypes: true })
  const byAlbum = new Map()
  for (const entry of entries) {
    if (!(await entryIsAudioInDir(entry, musicRoot))) continue
    const fullPath = path.join(musicRoot, entry.name)
    const { tagData, fileDurationMs } = await resolveTrackFileMeta(fullPath, opts)
    const identity = await resolveTrackIdentity(layout, {
      fileName: entry.name,
      filePath: entry.name,
      parentRel: "",
      folderArtist: null,
      folderAlbum: null,
      tags: tagData,
    })
    const artistName = identity.artist
    const albumFolderName = layoutAlbumFolderName(identity.album, false)
    const key = albumKey(artistName, albumFolderName)
    const track = trackFromFile({
      artistName,
      albumFolderName,
      albumDisplayName: identity.album,
      fileName: entry.name,
      fullPath,
      trackMeta: null,
      fileDurationMs,
      tagData,
      albumMeta: null,
      loose: false,
      enrichDuration: opts.enrichDuration !== false,
      readTags: Boolean(opts.readTags),
    })
    const list = byAlbum.get(key) || { artistName, albumFolderName, albumDisplayName: identity.album, tracks: [] }
    list.tracks.push(track)
    byAlbum.set(key, list)
  }

  const artists = []
  const albums = []
  const tracks = []
  for (const group of byAlbum.values()) {
    const albumDir = musicRoot
    const albumItem = buildAlbumItem({
      artistName: group.artistName,
      albumFolderName: group.albumFolderName,
      albumDisplayName: group.albumDisplayName,
      albumDir,
      albumTracks: group.tracks,
      albumMeta: null,
      loose: false,
    })
    albums.push(albumItem)
    tracks.push(...group.tracks)
    let artist = artists.find((a) => a.id === group.artistName)
    if (!artist) {
      artist = {
        id: group.artistName,
        name: group.artistName,
        albumCount: 0,
        trackCount: 0,
        releaseDate: null,
        coverRelPath: null,
        albums: [],
        albumsWithoutFileMetaCount: 0,
        tracksWithoutFileMetaCount: 0,
      }
      artists.push(artist)
    }
    artist.albums.push(albumItem.id)
    artist.albumCount += 1
    artist.trackCount += group.tracks.length
  }
  return { artists, albums, tracks }
}

function computeIndexStats(artists, albums, tracks) {
  return {
    artistCount: artists.length,
    albumCount: albums.length,
    trackCount: tracks.length,
    favoriteCapableCount: tracks.length,
    albumsWithoutCover: albums.filter((album) => !album.hasCover && !album.loose).length,
    albumsWithoutMeta: albums.filter((album) => !album.hasAlbumMeta && !album.loose).length,
    tracksWithoutMeta: tracks.filter(
      (track) =>
        !parseTrackGenres(track.meta?.genre).length && !track.meta?.releaseDate,
    ).length,
    looseAlbumCount: albums.filter((album) => album.loose).length,
  }
}

function mergeIndexParts(parts) {
  const artistMap = new Map()
  const albumMap = new Map()
  const trackMap = new Map()
  for (const part of parts) {
    if (part.artist) artistMap.set(part.artist.id, part.artist)
    for (const a of part.artists || []) artistMap.set(a.id, a)
    for (const al of part.albums || []) albumMap.set(al.id, al)
    for (const t of part.tracks || []) trackMap.set(t.relPath, t)
  }
  const artists = [...artistMap.values()].sort((a, b) => cmpByDateThenName(a, b))
  const albums = [...albumMap.values()].sort((a, b) => cmpByDateThenName(a, b))
  const tracks = [...trackMap.values()].sort((a, b) => cmpByDateThenName(a, b))
  return {
    artists,
    albums,
    tracks,
    stats: computeIndexStats(artists, albums, tracks),
  }
}

/**
 * Indicizza solo gli scope indicati (artist id o album relPath).
 * @param {string} musicRoot
 * @param {string[]} scopes es. ["Artist One", "Artist One/Album"]
 * @param {object} opts
 */
export async function buildPartialIndex(musicRoot, scopes, opts = {}) {
  const root = path.resolve(String(musicRoot || ""))
  const layout = opts.layout || (await loadLibraryLayout(root))
  const scanOpts = {
    enrichDuration: opts.enrichDuration !== false,
    readTags: Boolean(opts.readTags),
    existingDurations: opts.existingDurations || null,
  }
  const parts = []

  for (const scope of scopes) {
    const rel = String(scope || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    if (!rel) continue
    const partsSeg = rel.split("/").filter(Boolean)
    if (partsSeg.length === 1) {
      const artistDir = path.join(root, partsSeg[0])
      if (!existsSync(artistDir)) continue
      const branch = await buildArtistBranch(partsSeg[0], artistDir, scanOpts)
      if (branch) parts.push(branch)
    } else if (partsSeg.length >= 2) {
      const artistName = partsSeg[0]
      const albumName = partsSeg[1]
      const albumDir = path.join(root, artistName, albumName)
      if (!existsSync(albumDir)) continue
      const albumMeta = await loadAlbumJsonMetaFromDir(albumDir)
      const albumDisplayName =
        albumMeta?.title && String(albumMeta.title).trim()
          ? String(albumMeta.title).trim()
          : albumName
      const albumTracks = await readAlbumTracks(
        artistName,
        albumName,
        albumDir,
        albumMeta,
        scanOpts,
      )
      if (!albumTracks.length) continue
      const albumItem = buildAlbumItem({
        artistName,
        albumFolderName: albumName,
        albumDisplayName,
        albumDir,
        albumTracks,
        albumMeta,
        loose: false,
      })
      const branch = await buildArtistBranch(artistName, path.join(root, artistName), scanOpts)
      parts.push({
        artist: branch?.artist || {
          id: artistName,
          name: artistName,
          albumCount: 1,
          trackCount: albumTracks.length,
          releaseDate: albumItem.releaseDate,
          coverRelPath: albumItem.coverRelPath,
          albums: [albumItem.id],
          albumsWithoutFileMetaCount: albumItem.hasAlbumMeta ? 0 : 1,
          tracksWithoutFileMetaCount: albumItem.tracksWithoutFileMetaCount,
        },
        albums: [albumItem],
        tracks: albumTracks,
      })
    }
  }

  const merged = mergeIndexParts(parts)
  return { musicRoot: root, ...merged }
}

export function isAudioFile(name) {
  return hasAudio(name)
}

export function coverCandidates() {
  return [...COVER_FILES]
}

export async function buildLibraryIndex(musicRoot, opts = {}) {
  const root = path.resolve(String(musicRoot || ""))
  const layout = opts.layout || (await loadLibraryLayout(root))
  const scanOpts = {
    enrichDuration: opts.enrichDuration !== false,
    readTags: Boolean(opts.readTags),
    existingDurations: opts.existingDurations || null,
  }

  const top = await fs.readdir(root, { withFileTypes: true })
  const nodeKind = classifyFolderNode({ entries: top, relPath: "" })

  if (nodeKind === "flat" || layout.preferredLayout === "flat") {
    const flat = await buildFlatTracksAtRoot(root, layout, scanOpts)
    return { musicRoot: root, ...flat, stats: computeIndexStats(flat.artists, flat.albums, flat.tracks) }
  }

  const parts = []
  for (const entry of top) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || EXCLUDE.has(entry.name)) continue
    const artistDir = path.join(root, entry.name)
    const branch = await buildArtistBranch(entry.name, artistDir, scanOpts)
    if (branch) parts.push(branch)
  }

  const merged = mergeIndexParts(parts)
  return { musicRoot: root, ...merged }
}

export function toLegacyLibrary(index) {
  return {
    musicRoot: index.musicRoot,
    artists: index.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      trackCount: artist.trackCount,
      albums: artist.albums
        .map((albumId) => index.albums.find((album) => album.id === albumId))
        .filter(Boolean)
        .map((album) => ({
          id: album.loose ? "__loose__" : album.name,
          name: album.name,
          relPath: album.relPath,
          trackCount: album.trackCount,
          tracks: album.tracks
            .map((relPath) => index.tracks.find((track) => track.relPath === relPath))
            .filter(Boolean)
            .map((track) => ({
              id: track.id,
              title: track.title,
              relPath: track.relPath,
              meta: track.meta,
            })),
          ...(album.releaseDate || album.label || album.country || album.musicbrainzReleaseId
            ? {
                meta: {
                  releaseDate: album.releaseDate,
                  label: album.label,
                  country: album.country,
                  musicbrainzReleaseId: album.musicbrainzReleaseId,
                },
              }
            : {}),
        })),
    })),
  }
}

export const DASHBOARD_CONTINUE_LISTENING_LIMIT = 30

export function buildDashboard(index, userState) {
  const favoriteSet = new Set(userState?.favorites || [])
  const recentSet = new Set((userState?.recent || []).map((track) => track.relPath))
  const favoriteTracks = index.tracks.filter((track) => favoriteSet.has(track.relPath)).slice(0, 8)
  const recentTracks = index.tracks.filter((track) => recentSet.has(track.relPath)).slice(0, 8)
  const recentlyUpdatedAlbums = [...index.albums]
    .filter((album) => !album.loose)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 20)
  const qualityAlerts = [
    {
      id: "albums-without-cover",
      label: "Albums without cover art",
      count: index.stats.albumsWithoutCover,
      severity: index.stats.albumsWithoutCover > 0 ? "warning" : "ok",
    },
    {
      id: "albums-without-meta",
      label: "Albums without metadata",
      count: index.stats.albumsWithoutMeta,
      severity: index.stats.albumsWithoutMeta > 0 ? "warning" : "ok",
    },
    {
      id: "tracks-without-meta",
      label: "Brani senza metadati",
      count: index.stats.tracksWithoutMeta,
      severity: index.stats.tracksWithoutMeta > 0 ? "warning" : "ok",
    },
    {
      id: "loose-albums",
      label: "Folders with loose tracks",
      count: index.stats.looseAlbumCount,
      severity: index.stats.looseAlbumCount > 0 ? "info" : "ok",
    },
  ]
  return {
    stats: index.stats,
    continueListening: (userState?.queue?.tracks || []).slice(
      0,
      DASHBOARD_CONTINUE_LISTENING_LIMIT,
    ),
    recentTracks,
    favoriteTracks,
    recentlyUpdatedAlbums,
    qualityAlerts,
  }
}

export { DEFAULT_LAYOUT_CONFIG }
