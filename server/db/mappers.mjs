import { parseTrackGenres } from "../genres.mjs"

/** @param {Record<string, unknown> | undefined} row */
export function trackRowToIndex(row) {
  if (!row) return null
  const moods = row.moods_json ? safeJsonArray(row.moods_json) : []
  return {
    id: row.rel_path,
    title: row.title,
    relPath: row.rel_path,
    artist: row.artist_name,
    album: row.album_name,
    albumId: row.album_id,
    meta: {
      fileName: row.file_name || null,
      size: numOrNull(row.size),
      mtime: numOrNull(row.mtime),
      releaseDate: row.release_date || null,
      genre: row.genre || null,
      lyrics: row.lyrics || null,
      moods,
      durationMs: numOrNull(row.duration_ms),
      trackNumber: numOrNull(row.track_number),
      discNumber: numOrNull(row.disc_number),
      source: row.source || null,
      url: row.url || null,
    },
    loose: Boolean(row.loose),
    addedAt: numOrNull(row.added_at),
    updatedAt: numOrNull(row.updated_at),
  }
}

/** @param {Record<string, unknown> | undefined} row @param {string[]} trackRelPaths */
export function albumRowToIndex(row, trackRelPaths = []) {
  if (!row) return null
  return {
    id: row.id,
    artistId: row.artist_id,
    artist: row.artist_id,
    name: row.name,
    title: row.title || null,
    relPath: row.folder_rel_path,
    trackCount: Number(row.track_count) || trackRelPaths.length,
    coverRelPath: row.cover_rel_path || null,
    coverArtId: row.cover_art_id || null,
    releaseDate: row.release_date || null,
    genre: row.genre || null,
    label: row.label || null,
    country: row.country || null,
    musicbrainzReleaseId: row.musicbrainz_release_id || null,
    expectedTrackCount: numOrNull(row.expected_track_count),
    expectedTracks: null,
    hasCover: Boolean(row.has_cover),
    hasAlbumMeta: Boolean(row.has_album_meta),
    hasTrackMeta: Boolean(row.has_track_meta),
    tracksWithoutFileMetaCount: Number(row.tracks_without_file_meta_count) || 0,
    loose: Boolean(row.loose),
    addedAt: numOrNull(row.added_at),
    updatedAt: numOrNull(row.updated_at),
    tracks: trackRelPaths,
  }
}

/** @param {Record<string, unknown> | undefined} row @param {string[]} albumIds */
export function artistRowToIndex(row, albumIds = []) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    albumCount: Number(row.album_count) || albumIds.length,
    trackCount: Number(row.track_count) || 0,
    releaseDate: row.release_date || null,
    coverRelPath: row.cover_rel_path || null,
    coverArtId: row.cover_art_id || null,
    albums: albumIds,
    albumsWithoutFileMetaCount: Number(row.albums_without_file_meta_count) || 0,
    tracksWithoutFileMetaCount: Number(row.tracks_without_file_meta_count) || 0,
  }
}

function numOrNull(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null
}

function safeJsonArray(raw) {
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** @param {import('../musicLibrary.mjs').buildLibraryIndex extends Function ? Awaited<ReturnType<import('../musicLibrary.mjs').buildLibraryIndex>> : never} index */
export function computeStatsFromIndex(index) {
  return {
    artistCount: index.artists.length,
    albumCount: index.albums.length,
    trackCount: index.tracks.length,
    favoriteCapableCount: index.tracks.length,
    albumsWithoutCover: index.albums.filter((a) => !a.hasCover && !a.loose).length,
    albumsWithoutMeta: index.albums.filter((a) => !a.hasAlbumMeta && !a.loose).length,
    tracksWithoutMeta: index.tracks.filter(
      (t) => !parseTrackGenres(t.meta?.genre).length && !t.meta?.releaseDate,
    ).length,
    looseAlbumCount: index.albums.filter((a) => a.loose).length,
  }
}
