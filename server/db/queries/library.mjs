import path from "path"
import { existsSync, statSync } from "fs"
import { randomUUID } from "crypto"
import { getLibraryDb, withLibraryDbTransaction } from "../index.mjs"
import { trackPathLookupVariants } from "../migrateV6.mjs"
import { albumRowToIndex, artistRowToIndex, computeStatsFromIndex, trackRowToIndex } from "../mappers.mjs"
import { parseTrackGenres } from "../../genres.mjs"
import {
  registerFolderCoverArtwork,
  resolveArtworkFilePath,
} from "../../artwork/index.mjs"
import { orderAlbumTrackList } from "../../albumExpectedOrder.mjs"
import { recordLibraryDeltaFromScan } from "../../libraryDelta.mjs"
import { clearLibraryIndexCache } from "../../libraryIndexService.mjs"
import { getLibraryEpoch } from "../index.mjs"

const insertArtist = `
INSERT INTO artists (
  id, name, release_date, cover_rel_path, cover_art_id,
  album_count, track_count, albums_without_file_meta_count,
  tracks_without_file_meta_count, added_at, updated_at
) VALUES (
  @id, @name, @release_date, @cover_rel_path, @cover_art_id,
  @album_count, @track_count, @albums_without_file_meta_count,
  @tracks_without_file_meta_count, @added_at, @updated_at
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  release_date=excluded.release_date,
  cover_rel_path=excluded.cover_rel_path,
  cover_art_id=COALESCE(excluded.cover_art_id, artists.cover_art_id),
  album_count=excluded.album_count,
  track_count=excluded.track_count,
  albums_without_file_meta_count=excluded.albums_without_file_meta_count,
  tracks_without_file_meta_count=excluded.tracks_without_file_meta_count,
  added_at=COALESCE(artists.added_at, excluded.added_at),
  updated_at=excluded.updated_at
`

const insertAlbum = `
INSERT INTO albums (
  id, artist_id, folder_rel_path, name, title, release_date, genre, label, country,
  musicbrainz_release_id, discogs_release_id, discogs_extra_json, expected_track_count, cover_rel_path, cover_art_id,
  has_cover, has_album_meta, has_track_meta, tracks_without_file_meta_count,
  loose, track_count, added_at, updated_at, user_edited
) VALUES (
  @id, @artist_id, @folder_rel_path, @name, @title, @release_date, @genre, @label, @country,
  @musicbrainz_release_id, @discogs_release_id, @discogs_extra_json, @expected_track_count, @cover_rel_path, @cover_art_id,
  @has_cover, @has_album_meta, @has_track_meta, @tracks_without_file_meta_count,
  @loose, @track_count, @added_at, @updated_at, @user_edited
)
ON CONFLICT(id) DO UPDATE SET
  artist_id=excluded.artist_id,
  folder_rel_path=excluded.folder_rel_path,
  name=excluded.name,
  title=excluded.title,
  release_date=excluded.release_date,
  genre=excluded.genre,
  label=excluded.label,
  country=excluded.country,
  musicbrainz_release_id=excluded.musicbrainz_release_id,
  discogs_release_id=COALESCE(excluded.discogs_release_id, albums.discogs_release_id),
  discogs_extra_json=COALESCE(excluded.discogs_extra_json, albums.discogs_extra_json),
  expected_track_count=excluded.expected_track_count,
  cover_rel_path=excluded.cover_rel_path,
  cover_art_id=COALESCE(excluded.cover_art_id, albums.cover_art_id),
  has_cover=excluded.has_cover,
  has_album_meta=excluded.has_album_meta,
  has_track_meta=excluded.has_track_meta,
  tracks_without_file_meta_count=excluded.tracks_without_file_meta_count,
  loose=excluded.loose,
  track_count=excluded.track_count,
  added_at=COALESCE(albums.added_at, excluded.added_at),
  updated_at=excluded.updated_at
`

const insertTrack = `
INSERT INTO tracks (
  id, rel_path, file_path, album_id, title, artist_name, album_name, genre, release_date,
  lyrics, moods_json, duration_ms, track_number, disc_number, source, url,
  file_name, size, mtime, loose, added_at, updated_at, user_edited
) VALUES (
  @id, @rel_path, @file_path, @album_id, @title, @artist_name, @album_name, @genre, @release_date,
  @lyrics, @moods_json, @duration_ms, @track_number, @disc_number, @source, @url,
  @file_name, @size, @mtime, @loose, @added_at, @updated_at, @user_edited
)
ON CONFLICT(rel_path) DO UPDATE SET
  file_path=excluded.file_path,
  album_id=excluded.album_id,
  title=CASE WHEN tracks.user_edited = 1 THEN tracks.title ELSE excluded.title END,
  artist_name=CASE WHEN tracks.user_edited = 1 THEN tracks.artist_name ELSE excluded.artist_name END,
  album_name=CASE WHEN tracks.user_edited = 1 THEN tracks.album_name ELSE excluded.album_name END,
  genre=CASE WHEN tracks.user_edited = 1 THEN tracks.genre ELSE excluded.genre END,
  release_date=CASE WHEN tracks.user_edited = 1 THEN tracks.release_date ELSE excluded.release_date END,
  lyrics=CASE WHEN tracks.user_edited = 1 THEN tracks.lyrics ELSE excluded.lyrics END,
  moods_json=CASE WHEN tracks.user_edited = 1 THEN tracks.moods_json ELSE excluded.moods_json END,
  duration_ms=CASE WHEN tracks.user_edited = 1 AND tracks.duration_ms IS NOT NULL THEN tracks.duration_ms ELSE excluded.duration_ms END,
  track_number=CASE WHEN tracks.user_edited = 1 THEN tracks.track_number ELSE excluded.track_number END,
  disc_number=CASE WHEN tracks.user_edited = 1 THEN tracks.disc_number ELSE excluded.disc_number END,
  source=CASE WHEN tracks.user_edited = 1 THEN tracks.source ELSE excluded.source END,
  url=CASE WHEN tracks.user_edited = 1 THEN tracks.url ELSE excluded.url END,
  file_name=excluded.file_name,
  size=excluded.size,
  mtime=excluded.mtime,
  loose=excluded.loose,
  added_at=COALESCE(tracks.added_at, excluded.added_at),
  updated_at=excluded.updated_at
`

function trackFilePath(track) {
  return track.filePath || track.relPath
}

function upsertTrackRow(db, track, musicRoot, statements) {
  const { insTrack, insFts, insFile } = statements
  const filePath = trackFilePath(track)
  const moods = track.meta?.moods
  insTrack.run({
    id: track.id || track.relPath,
    rel_path: track.relPath,
    file_path: filePath,
    album_id: track.albumId,
    title: track.title,
    artist_name: track.artist,
    album_name: track.album,
    genre: track.meta?.genre || null,
    release_date: track.meta?.releaseDate || null,
    lyrics: track.meta?.lyrics || null,
    moods_json: moods?.length ? JSON.stringify(moods) : null,
    duration_ms: track.meta?.durationMs ?? null,
    track_number: track.meta?.trackNumber ?? null,
    disc_number: track.meta?.discNumber ?? null,
    source: track.meta?.source || null,
    url: track.meta?.url || null,
    file_name: track.meta?.fileName || path.basename(filePath),
    size: track.meta?.size ?? null,
    mtime: track.meta?.mtime ?? null,
    loose: track.loose ? 1 : 0,
    added_at: track.addedAt || null,
    updated_at: track.updatedAt || Date.now(),
    user_edited: 0,
  })
  db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(track.relPath)
  insFts.run(
    track.title,
    track.artist,
    track.album,
    track.meta?.genre || "",
    track.relPath,
  )
  try {
    const full = path.join(musicRoot, filePath.replaceAll("/", path.sep))
    if (existsSync(full)) {
      const st = statSync(full)
      insFile.run(filePath, st.size, Math.round(st.mtimeMs * 1e6))
    }
  } catch {
    /* ok */
  }
}

function upsertAlbumRow(db, album, statements) {
  const { insAlbum, insExpected } = statements
  insAlbum.run({
    id: album.id,
    artist_id: album.artistId,
    folder_rel_path: album.relPath,
    name: album.name,
    title: album.title || null,
    release_date: album.releaseDate || null,
    genre: album.genre || null,
    label: album.label || null,
    country: album.country || null,
    musicbrainz_release_id: album.musicbrainzReleaseId || null,
    discogs_release_id: album.discogsReleaseId ?? null,
    discogs_extra_json: album.discogsExtra
      ? JSON.stringify(album.discogsExtra).slice(0, 32000)
      : null,
    expected_track_count: album.expectedTrackCount ?? null,
    cover_rel_path: album.coverRelPath || null,
    cover_art_id: album.coverArtId || null,
    has_cover: album.hasCover ? 1 : 0,
    has_album_meta: album.hasAlbumMeta ? 1 : 0,
    has_track_meta: album.hasTrackMeta ? 1 : 0,
    tracks_without_file_meta_count: album.tracksWithoutFileMetaCount || 0,
    loose: album.loose ? 1 : 0,
    track_count: album.trackCount || 0,
    added_at: album.addedAt || null,
    updated_at: album.updatedAt || Date.now(),
    user_edited: 0,
  })
  if (Array.isArray(album.expectedTracks)) {
    db.prepare("DELETE FROM album_expected_tracks WHERE album_id = ?").run(album.id)
    for (const row of album.expectedTracks) {
      if (!row?.title) continue
      insExpected.run(
        album.id,
        Number.isFinite(Number(row.disc)) ? Number(row.disc) : 1,
        Number.isFinite(Number(row.position)) ? Number(row.position) : null,
        String(row.title).trim(),
      )
    }
  }
}

function upsertArtistRow(db, artist, insArtist) {
  insArtist.run({
    id: artist.id,
    name: artist.name,
    release_date: artist.releaseDate || null,
    cover_rel_path: artist.coverRelPath || null,
    cover_art_id: artist.coverArtId || null,
    album_count: artist.albumCount || 0,
    track_count: artist.trackCount || 0,
    albums_without_file_meta_count: artist.albumsWithoutFileMetaCount || 0,
    tracks_without_file_meta_count: artist.tracksWithoutFileMetaCount || 0,
    added_at: artist.addedAt || null,
    updated_at: artist.updatedAt || Date.now(),
  })
}

function removeTrackByFilePath(db, filePath) {
  const variants = trackPathLookupVariants(filePath)
  let row = null
  for (const fp of variants) {
    row = db
      .prepare(
        `SELECT t.rel_path, t.album_id, a.artist_id
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         WHERE t.file_path = ? OR t.rel_path = ?
         LIMIT 1`,
      )
      .get(fp, fp)
    if (row) break
  }
  if (!row) return null
  db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(row.rel_path)
  db.prepare("DELETE FROM tracks WHERE rel_path = ?").run(row.rel_path)
  for (const fp of variants) {
    db.prepare("DELETE FROM files WHERE rel_path = ?").run(fp)
  }
  return { relPath: row.rel_path, albumId: row.album_id, artistId: row.artist_id }
}

function pruneEmptyAlbumsForArtists(db, artistIds) {
  const ids = [...new Set((artistIds || []).filter(Boolean))]
  if (!ids.length) return
  const placeholders = ids.map(() => "?").join(",")
  const emptyAlbums = db
    .prepare(
      `SELECT a.id, a.artist_id
       FROM albums a
       LEFT JOIN tracks t ON t.album_id = a.id
       WHERE a.artist_id IN (${placeholders})
       GROUP BY a.id
       HAVING COUNT(t.id) = 0`,
    )
    .all(...ids)
  for (const album of emptyAlbums) {
    db.prepare("DELETE FROM album_expected_tracks WHERE album_id = ?").run(album.id)
    db.prepare("DELETE FROM albums WHERE id = ?").run(album.id)
  }
  const artistsWithoutAlbums = db
    .prepare(
      `SELECT a.id
       FROM artists a
       LEFT JOIN albums al ON al.artist_id = a.id
       WHERE a.id IN (${placeholders})
       GROUP BY a.id
       HAVING COUNT(al.id) = 0`,
    )
    .all(...ids)
  for (const artist of artistsWithoutAlbums) {
    db.prepare("DELETE FROM artists WHERE id = ?").run(artist.id)
  }
}

/**
 * Persiste un indice completo nel DB (bootstrap o full rescan).
 * @param {string} libraryRoot
 * @param {object} index
 * @param {{ preserveUserEdited?: boolean }} opts
 */
export async function persistLibraryIndexToDb(libraryRoot, index, opts = {}) {
  const musicRoot = path.resolve(String(libraryRoot || index.musicRoot || ""))
  withLibraryDbTransaction(musicRoot, (db) => {
    const seenTracks = new Set()
    const seenAlbums = new Set()
    const seenArtists = new Set()

    db.prepare("DELETE FROM album_expected_tracks").run()
    db.prepare("DELETE FROM tracks_fts").run()

    const insArtist = db.prepare(insertArtist)
    const insAlbum = db.prepare(insertAlbum)
    const insTrack = db.prepare(insertTrack)
    const insExpected = db.prepare(
      "INSERT INTO album_expected_tracks (album_id, disc, position, title) VALUES (?, ?, ?, ?)",
    )
    const insFts = db.prepare(
      "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
    )
    const insFile = db.prepare(
      "INSERT INTO files (rel_path, size, mtime_ns) VALUES (?, ?, ?) ON CONFLICT(rel_path) DO UPDATE SET size=excluded.size, mtime_ns=excluded.mtime_ns",
    )

    for (const artist of index.artists || []) {
      seenArtists.add(artist.id)
      insArtist.run({
        id: artist.id,
        name: artist.name,
        release_date: artist.releaseDate || null,
        cover_rel_path: artist.coverRelPath || null,
        cover_art_id: artist.coverArtId || null,
        album_count: artist.albumCount || 0,
        track_count: artist.trackCount || 0,
        albums_without_file_meta_count: artist.albumsWithoutFileMetaCount || 0,
        tracks_without_file_meta_count: artist.tracksWithoutFileMetaCount || 0,
        added_at: artist.addedAt || null,
        updated_at: artist.updatedAt || Date.now(),
      })
    }

    for (const album of index.albums || []) {
      seenAlbums.add(album.id)
      insAlbum.run({
        id: album.id,
        artist_id: album.artistId,
        folder_rel_path: album.relPath,
        name: album.name,
        title: album.title || null,
        release_date: album.releaseDate || null,
        genre: album.genre || null,
        label: album.label || null,
        country: album.country || null,
        musicbrainz_release_id: album.musicbrainzReleaseId || null,
        discogs_release_id: album.discogsReleaseId ?? null,
        discogs_extra_json: album.discogsExtra
          ? JSON.stringify(album.discogsExtra).slice(0, 32000)
          : null,
        expected_track_count: album.expectedTrackCount ?? null,
        cover_rel_path: album.coverRelPath || null,
        cover_art_id: album.coverArtId || null,
        has_cover: album.hasCover ? 1 : 0,
        has_album_meta: album.hasAlbumMeta ? 1 : 0,
        has_track_meta: album.hasTrackMeta ? 1 : 0,
        tracks_without_file_meta_count: album.tracksWithoutFileMetaCount || 0,
        loose: album.loose ? 1 : 0,
        track_count: album.trackCount || 0,
        added_at: album.addedAt || null,
        updated_at: album.updatedAt || Date.now(),
        user_edited: 0,
      })
      if (Array.isArray(album.expectedTracks)) {
        for (const row of album.expectedTracks) {
          if (!row?.title) continue
          insExpected.run(
            album.id,
            Number.isFinite(Number(row.disc)) ? Number(row.disc) : 1,
            Number.isFinite(Number(row.position)) ? Number(row.position) : null,
            String(row.title).trim(),
          )
        }
      }
    }

    for (const track of index.tracks || []) {
      seenTracks.add(track.relPath)
      upsertTrackRow(db, track, musicRoot, { insTrack, insFts, insFile })
    }

    if (!opts.preserveUserEdited) {
      const delTrack = db.prepare("DELETE FROM tracks WHERE rel_path = ?")
      const delFts = db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?")
      for (const row of db.prepare("SELECT rel_path FROM tracks").all()) {
        if (!seenTracks.has(row.rel_path)) {
          delFts.run(row.rel_path)
          delTrack.run(row.rel_path)
        }
      }

      const delAlbum = db.prepare("DELETE FROM albums WHERE id = ?")
      for (const row of db.prepare("SELECT id FROM albums").all()) {
        if (!seenAlbums.has(row.id)) delAlbum.run(row.id)
      }

      const delArtist = db.prepare("DELETE FROM artists WHERE id = ?")
      for (const row of db.prepare("SELECT id FROM artists").all()) {
        if (!seenArtists.has(row.id)) delArtist.run(row.id)
      }
    }

    db.prepare(
      `UPDATE library_state SET
        bootstrapped_at = @at,
        music_root = @root,
        last_full_scan_at = @at,
        last_incremental_at = @at,
        epoch = epoch + 1
      WHERE id = 1`,
    ).run({
      at: new Date().toISOString(),
      root: musicRoot,
    })
  })

  for (const album of index.albums || []) {
    if (album.coverRelPath && album.hasCover) {
      await registerFolderCoverArtwork(musicRoot, album.id, album.coverRelPath).catch(() => {})
    }
  }
  try {
    recordLibraryDeltaFromScan(musicRoot, getLibraryEpoch(musicRoot), { full: true })
  } catch {
    /* ok */
  }
  clearLibraryIndexCache(musicRoot)
}

/**
 * Persiste un aggiornamento parziale (scan incrementale).
 * @param {string} libraryRoot
 * @param {object} index
 * @param {{ removedPaths?: string[] }} opts
 */
export async function persistIncrementalToDb(libraryRoot, index, opts = {}) {
  const musicRoot = path.resolve(String(libraryRoot || index.musicRoot || ""))
  const removedPaths = opts.removedPaths || []
  const touchedArtistIds = new Set()

  withLibraryDbTransaction(musicRoot, (db) => {
    const insArtist = db.prepare(insertArtist)
    const insAlbum = db.prepare(insertAlbum)
    const insTrack = db.prepare(insertTrack)
    const insExpected = db.prepare(
      "INSERT INTO album_expected_tracks (album_id, disc, position, title) VALUES (?, ?, ?, ?)",
    )
    const insFts = db.prepare(
      "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
    )
    const insFile = db.prepare(
      "INSERT INTO files (rel_path, size, mtime_ns) VALUES (?, ?, ?) ON CONFLICT(rel_path) DO UPDATE SET size=excluded.size, mtime_ns=excluded.mtime_ns",
    )
    const stmts = { insAlbum, insExpected, insTrack, insFts, insFile }

    for (const fp of removedPaths) {
      const removed = removeTrackByFilePath(db, fp)
      if (removed?.artistId) touchedArtistIds.add(removed.artistId)
    }

    for (const artist of index.artists || []) {
      touchedArtistIds.add(artist.id)
      upsertArtistRow(db, artist, insArtist)
    }
    for (const album of index.albums || []) {
      touchedArtistIds.add(album.artistId)
      upsertAlbumRow(db, album, stmts)
    }
    for (const track of index.tracks || []) {
      const albumRow = db
        .prepare("SELECT artist_id FROM albums WHERE id = ? LIMIT 1")
        .get(track.albumId)
      if (albumRow?.artist_id) touchedArtistIds.add(albumRow.artist_id)
      else if (track.artist) touchedArtistIds.add(track.artist)
      upsertTrackRow(db, track, musicRoot, stmts)
    }

    pruneEmptyAlbumsForArtists(db, [...touchedArtistIds])

    db.prepare(
      `UPDATE library_state SET
        bootstrapped_at = COALESCE(bootstrapped_at, @at),
        music_root = @root,
        last_incremental_at = @at,
        epoch = epoch + 1
      WHERE id = 1`,
    ).run({
      at: new Date().toISOString(),
      root: musicRoot,
    })
  })

  for (const album of index.albums || []) {
    if (album.coverRelPath && album.hasCover) {
      await registerFolderCoverArtwork(musicRoot, album.id, album.coverRelPath).catch(() => {})
    }
  }
  try {
    recordLibraryDeltaFromScan(musicRoot, getLibraryEpoch(musicRoot), {
      removedPaths,
      index,
    })
  } catch {
    /* ok */
  }
  clearLibraryIndexCache(musicRoot)
}

export function getLibraryScanState(libraryRoot) {
  const db = getLibraryDb(libraryRoot)
  const row = db.prepare(
    "SELECT epoch, last_incremental_at, last_full_scan_at FROM library_state WHERE id = 1",
  ).get()
  return {
    indexEpoch: Number(row?.epoch) || 0,
    lastIncrementalAt: row?.last_incremental_at || null,
    lastFullScanAt: row?.last_full_scan_at || null,
  }
}

/** @param {string} libraryRoot */
export function buildLibraryIndexFromDb(libraryRoot) {
  const db = getLibraryDb(libraryRoot)
  const musicRoot = path.resolve(String(libraryRoot))

  const artistRows = db.prepare("SELECT * FROM artists ORDER BY name COLLATE NOCASE").all()
  const albumRows = db.prepare("SELECT * FROM albums ORDER BY release_date, name").all()
  const trackRows = db
    .prepare(
      `SELECT t.*, a.folder_rel_path AS album_folder_rel_path
       FROM tracks t
       JOIN albums a ON a.id = t.album_id`,
    )
    .all()

  const trackObjsByAlbum = new Map()
  for (const row of trackRows) {
    const track = trackRowToIndex(row)
    const list = trackObjsByAlbum.get(row.album_id) || []
    list.push(track)
    trackObjsByAlbum.set(row.album_id, list)
  }

  const expectedByAlbum = new Map()
  const expectedRows = db
    .prepare(
      "SELECT album_id, disc, position, title FROM album_expected_tracks ORDER BY album_id, disc, position, title",
    )
    .all()
  for (const row of expectedRows) {
    const list = expectedByAlbum.get(row.album_id) || []
    list.push({
      disc: row.disc,
      position: row.position,
      title: row.title,
    })
    expectedByAlbum.set(row.album_id, list)
  }

  const albumsByArtist = new Map()
  const albums = albumRows.map((row) => {
    const expectedTracks = expectedByAlbum.get(row.id) || []
    const orderedTracks = orderAlbumTrackList(trackObjsByAlbum.get(row.id) || [])
    const trackPaths = orderedTracks.map((t) => t.relPath)
    const list = albumsByArtist.get(row.artist_id) || []
    list.push(row.id)
    albumsByArtist.set(row.artist_id, list)
    const album = albumRowToIndex(row, trackPaths)
    if (album && expectedTracks.length) {
      album.expectedTracks = expectedTracks
    }
    return album
  })

  const artists = artistRows.map((row) =>
    artistRowToIndex(row, albumsByArtist.get(row.id) || []),
  )

  const albumNameById = new Map(albums.map((album) => [album.id, album.name]))
  const albumHasMetaById = new Map(
    albums.map((album) => [album.id, album.hasAlbumMeta]),
  )
  const tracks = trackRows.map((row) => {
    const track = trackRowToIndex(row)
    if (!albumHasMetaById.get(row.album_id)) return track
    const albumName = albumNameById.get(row.album_id)
    if (!albumName || albumName === track.album) return track
    return { ...track, album: albumName }
  })

  const index = {
    musicRoot,
    artists,
    albums,
    tracks,
    stats: computeStatsFromIndex({ artists, albums, tracks }),
  }
  return index
}

/** @param {string} libraryRoot @param {string} query */
export function searchLibraryDb(libraryRoot, query) {
  const q = String(query || "").trim()
  if (!q) return { artists: [], albums: [], tracks: [] }
  const db = getLibraryDb(libraryRoot)
  const ftsQ = q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(" AND ")

  let trackRows = []
  try {
    trackRows = db
      .prepare(
        `SELECT t.* FROM tracks_fts f
         JOIN tracks t ON t.rel_path = f.rel_path
         WHERE tracks_fts MATCH ?
         LIMIT 150`,
      )
      .all(ftsQ)
  } catch {
    const like = `%${q.toLowerCase()}%`
    trackRows = db
      .prepare(
        `SELECT * FROM tracks WHERE
         lower(title) LIKE ? OR lower(artist_name) LIKE ? OR lower(album_name) LIKE ? OR lower(COALESCE(genre,'')) LIKE ?
         LIMIT 150`,
      )
      .all(like, like, like, like)
  }

  const tracks = trackRows.map((row) => trackRowToIndex(row))
  const artistNames = [...new Set(tracks.map((t) => t.artist))]
  let artists = []
  if (artistNames.length) {
    artists = db
      .prepare(
        `SELECT * FROM artists WHERE lower(name) LIKE ? OR id IN (${artistNames.map(() => "?").join(",")}) LIMIT 50`,
      )
      .all(`%${q.toLowerCase()}%`, ...artistNames)
  } else {
    artists = db
      .prepare("SELECT * FROM artists WHERE lower(name) LIKE ? LIMIT 50")
      .all(`%${q.toLowerCase()}%`)
  }

  const albumIds = [...new Set(tracks.map((t) => t.albumId))]
  let albums = []
  if (albumIds.length) {
    albums = db
      .prepare(
        `SELECT * FROM albums WHERE lower(name) LIKE ? OR lower(artist_id) LIKE ? OR id IN (${albumIds.map(() => "?").join(",")}) LIMIT 80`,
      )
      .all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, ...albumIds)
  } else {
    albums = db
      .prepare(
        "SELECT * FROM albums WHERE lower(name) LIKE ? OR lower(artist_id) LIKE ? LIMIT 80",
      )
      .all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`)
  }

  return {
    artists: artists.map((row) => artistRowToIndex(row, [])),
    albums: albums.map((row) => albumRowToIndex(row, [])),
    tracks,
  }
}

/** @param {string} libraryRoot */
export function listArtistsPaginated(libraryRoot, { offset = 0, limit = 50, sort = "name" } = {}) {
  const db = getLibraryDb(libraryRoot)
  const order =
    sort === "tracks"
      ? "track_count DESC, name COLLATE NOCASE"
      : "name COLLATE NOCASE"
  const rows = db
    .prepare(`SELECT * FROM artists ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(Math.min(500, Math.max(1, limit)), Math.max(0, offset))
  if (!rows.length) return []

  const artistIds = rows.map((row) => row.id)
  const placeholders = artistIds.map(() => "?").join(",")
  const albumRows = db
    .prepare(
      `SELECT id, artist_id FROM albums WHERE artist_id IN (${placeholders}) ORDER BY release_date, name`,
    )
    .all(...artistIds)
  const albumsByArtist = new Map()
  for (const albumRow of albumRows) {
    const list = albumsByArtist.get(albumRow.artist_id) || []
    list.push(albumRow.id)
    albumsByArtist.set(albumRow.artist_id, list)
  }

  return rows.map((row) => artistRowToIndex(row, albumsByArtist.get(row.id) || []))
}

/** @param {string} libraryRoot @param {string} artistId */
export function listAlbumsForArtist(libraryRoot, artistId) {
  const db = getLibraryDb(libraryRoot)
  const rows = db
    .prepare("SELECT * FROM albums WHERE artist_id = ? ORDER BY release_date, name")
    .all(artistId)
  if (!rows.length) return []

  const albumIds = rows.map((row) => row.id)
  const placeholders = albumIds.map(() => "?").join(",")
  const trackRows = db
    .prepare(`SELECT * FROM tracks WHERE album_id IN (${placeholders})`)
    .all(...albumIds)
  const tracksByAlbum = new Map()
  for (const trackRow of trackRows) {
    const list = tracksByAlbum.get(trackRow.album_id) || []
    list.push(trackRow)
    tracksByAlbum.set(trackRow.album_id, list)
  }

  return rows.map((row) => {
    const albumTrackRows = tracksByAlbum.get(row.id) || []
    const trackPaths = orderAlbumTrackList(albumTrackRows.map((r) => trackRowToIndex(r))).map(
      (t) => t.relPath,
    )
    return albumRowToIndex(row, trackPaths)
  })
}

/** @param {string} libraryRoot @param {string} artistId */
export function getArtistDetailFromDb(libraryRoot, artistId) {
  const db = getLibraryDb(libraryRoot)
  const row = db
    .prepare("SELECT * FROM artists WHERE id = ? OR name = ? LIMIT 1")
    .get(artistId, artistId)
  if (!row) return null
  const albums = listAlbumsForArtist(libraryRoot, row.id)
  const albumIds = albums.map((album) => album.id)
  const tracks = []
  if (albumIds.length) {
    const placeholders = albumIds.map(() => "?").join(",")
    const trackRows = db
      .prepare(`SELECT * FROM tracks WHERE album_id IN (${placeholders})`)
      .all(...albumIds)
    tracks.push(...trackRows.map((trackRow) => trackRowToIndex(trackRow)))
  }
  tracks.sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)))
  return {
    artist: artistRowToIndex(row, albumIds),
    albums,
    tracks,
  }
}

/** @param {string} libraryRoot @param {string} folderRelPath */
export function getAlbumTracksFromDb(libraryRoot, folderRelPath) {
  const db = getLibraryDb(libraryRoot)
  const album = db
    .prepare("SELECT * FROM albums WHERE folder_rel_path = ? OR id = ? LIMIT 1")
    .get(folderRelPath, folderRelPath)
  if (!album) return null
  const trackRows = db.prepare("SELECT * FROM tracks WHERE album_id = ?").all(album.id)
  const expected = db
    .prepare(
      "SELECT disc, position, title FROM album_expected_tracks WHERE album_id = ? ORDER BY disc, position, title",
    )
    .all(album.id)
  const expectedTracks = expected.map((e) => ({
    disc: e.disc,
    position: e.position,
    title: e.title,
  }))
  const orderedTracks = orderAlbumTrackList(trackRows.map((r) => trackRowToIndex(r)))
  const trackPaths = orderedTracks.map((t) => t.relPath)
  const albumIndex = albumRowToIndex(album, trackPaths)
  if (albumIndex && expectedTracks.length) {
    albumIndex.expectedTracks = expectedTracks
  }
  return {
    album: albumIndex,
    tracks: orderedTracks,
  }
}

/** @param {string} libraryRoot */
export function getArtworkRecord(libraryRoot, artworkId) {
  const db = getLibraryDb(libraryRoot)
  return db.prepare("SELECT * FROM artwork WHERE id = ?").get(String(artworkId || "")) || null
}

export function newArtworkId() {
  return randomUUID().replace(/-/g, "").slice(0, 16)
}

/** Album con cover su disco ma cache artwork assente o file mancanti. */
export async function backfillMissingArtworkCache(libraryRoot) {
  const db = getLibraryDb(libraryRoot)
  const rows = db
    .prepare(
      `SELECT id, cover_rel_path, cover_art_id FROM albums
       WHERE has_cover = 1 AND cover_rel_path IS NOT NULL AND cover_rel_path != ''`,
    )
    .all()
  for (const row of rows) {
    const artId = String(row.cover_art_id || "").trim()
    if (artId && resolveArtworkFilePath(libraryRoot, artId, "128")) continue
    if (artId) {
      db.prepare("UPDATE albums SET cover_art_id = NULL WHERE id = ?").run(row.id)
    }
    await registerFolderCoverArtwork(
      libraryRoot,
      row.id,
      row.cover_rel_path,
    ).catch(() => {})
  }
}
