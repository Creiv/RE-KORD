import path from "path"
import { getLibraryDb, bumpLibraryEpoch, withLibraryDbTransaction } from "../index.mjs"
import { normalizeStoredGenreString } from "../../genres.mjs"
import { albumRowToIndex } from "../mappers.mjs"

function str(v, max) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/** @param {string} libraryRoot @param {string} folderRelPath */
export function getAlbumRowByFolderRel(libraryRoot, folderRelPath) {
  const db = getLibraryDb(libraryRoot)
  return (
    db.prepare("SELECT * FROM albums WHERE folder_rel_path = ? LIMIT 1").get(folderRelPath) ||
    null
  )
}

/**
 * @param {string} libraryRoot
 * @param {string} folderRelPath
 * @param {Record<string, unknown>} patch
 */
export function saveAlbumMetaToDb(libraryRoot, folderRelPath, patch) {
  const db = getLibraryDb(libraryRoot)
  const prev = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!prev) throw new Error("Album not found in library database")

  const next = {
    title: Object.prototype.hasOwnProperty.call(patch, "title")
      ? str(patch.title, 500)
      : prev.title,
    release_date: Object.prototype.hasOwnProperty.call(patch, "releaseDate")
      ? str(patch.releaseDate, 64)
      : prev.release_date,
    genre: Object.prototype.hasOwnProperty.call(patch, "genre")
      ? patch.genre === "" || patch.genre == null
        ? null
        : str(normalizeStoredGenreString(String(patch.genre)), 800)
      : prev.genre,
    label: Object.prototype.hasOwnProperty.call(patch, "label")
      ? str(patch.label, 300)
      : prev.label,
    country: Object.prototype.hasOwnProperty.call(patch, "country")
      ? str(patch.country, 64)
      : prev.country,
    musicbrainz_release_id: Object.prototype.hasOwnProperty.call(
      patch,
      "musicbrainzReleaseId",
    )
      ? str(patch.musicbrainzReleaseId, 200)
      : prev.musicbrainz_release_id,
    discogs_release_id: Object.prototype.hasOwnProperty.call(patch, "discogsReleaseId")
      ? Number.isFinite(Number(patch.discogsReleaseId))
        ? Number(patch.discogsReleaseId)
        : null
      : prev.discogs_release_id,
    discogs_extra_json: Object.prototype.hasOwnProperty.call(patch, "discogsExtra")
      ? patch.discogsExtra == null
        ? null
        : JSON.stringify(patch.discogsExtra).slice(0, 32000)
      : prev.discogs_extra_json,
  }

  const displayName =
    next.title && String(next.title).trim()
      ? String(next.title).trim()
      : prev.name

  let expectedTrackCount = prev.expected_track_count
  if (Object.prototype.hasOwnProperty.call(patch, "expectedTrackCount")) {
    const n = Number(patch.expectedTrackCount)
    expectedTrackCount = Number.isFinite(n) && n > 0 ? n : null
  }

  withLibraryDbTransaction(libraryRoot, () => {
    db.prepare(
      `UPDATE albums SET
        title = @title,
        name = @name,
        release_date = @release_date,
        genre = @genre,
        label = @label,
        country = @country,
        musicbrainz_release_id = @musicbrainz_release_id,
        discogs_release_id = @discogs_release_id,
        discogs_extra_json = @discogs_extra_json,
        expected_track_count = @expected_track_count,
        has_album_meta = 1,
        user_edited = 1,
        updated_at = @updated_at
      WHERE folder_rel_path = @folder_rel_path`,
    ).run({
      ...next,
      name: displayName,
      expected_track_count: expectedTrackCount,
      folder_rel_path: folderRelPath,
      updated_at: Date.now(),
    })

    if (Object.prototype.hasOwnProperty.call(patch, "expectedTracks")) {
      const rows = Array.isArray(patch.expectedTracks) ? patch.expectedTracks : []
      db.prepare("DELETE FROM album_expected_tracks WHERE album_id = ?").run(prev.id)
      const insExpected = db.prepare(
        "INSERT INTO album_expected_tracks (album_id, disc, position, title) VALUES (?, ?, ?, ?)",
      )
      for (const row of rows) {
        const title = row?.title != null ? String(row.title).trim() : ""
        if (!title) continue
        insExpected.run(
          prev.id,
          Number.isFinite(Number(row.disc)) ? Number(row.disc) : 1,
          Number.isFinite(Number(row.position)) ? Number(row.position) : null,
          title,
        )
      }
      if (rows.length) expectedTrackCount = rows.filter((r) => r?.title).length
      db.prepare(
        "UPDATE albums SET expected_track_count = ? WHERE folder_rel_path = ?",
      ).run(expectedTrackCount, folderRelPath)
    }

    if (displayName && displayName !== prev.name) {
      const now = Date.now()
      db.prepare(
        "UPDATE tracks SET album_name = ?, updated_at = ? WHERE album_id = ?",
      ).run(displayName, now, prev.id)
      const trackRows = db
        .prepare("SELECT rel_path, title, artist_name, genre FROM tracks WHERE album_id = ?")
        .all(prev.id)
      const updFts = db.prepare(
        "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
      )
      for (const track of trackRows) {
        db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(track.rel_path)
        updFts.run(
          track.title,
          track.artist_name,
          displayName,
          track.genre || "",
          track.rel_path,
        )
      }
    }
  })

  bumpLibraryEpoch(libraryRoot)
  const row = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  const expectedRows = getLibraryDb(libraryRoot)
    .prepare(
      "SELECT disc, position, title FROM album_expected_tracks WHERE album_id = ? ORDER BY disc, position, title",
    )
    .all(row?.id)
  const expectedTracks = expectedRows.length
    ? expectedRows.map((r) => ({
        disc: r.disc,
        position: r.position,
        title: r.title,
      }))
    : null
  return {
    title: row?.title || null,
    releaseDate: row?.release_date || null,
    genre: row?.genre || null,
    label: row?.label || null,
    country: row?.country || null,
    musicbrainzReleaseId: row?.musicbrainz_release_id || null,
    discogsReleaseId: row?.discogs_release_id ?? null,
    discogsUri: (() => {
      try {
        const j = row?.discogs_extra_json ? JSON.parse(row.discogs_extra_json) : null
        return j?.discogsUri || null
      } catch {
        return null
      }
    })(),
    discogsExtra: (() => {
      try {
        return row?.discogs_extra_json ? JSON.parse(row.discogs_extra_json) : null
      } catch {
        return null
      }
    })(),
    expectedTrackCount: row?.expected_track_count ?? null,
    expectedTracks,
    editedAt: new Date().toISOString(),
  }
}

/**
 * @param {string} libraryRoot
 * @param {string} relPath track rel path
 * @param {Record<string, unknown>} patch
 */
export function saveTrackMetaToDb(libraryRoot, relPath, patch) {
  const db = getLibraryDb(libraryRoot)
  const prev = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(relPath)
  if (!prev) throw new Error("Track not found in library database")

  const next = { ...prev }
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    next.title = str(patch.title, 500) || prev.title
  }
  if (Object.prototype.hasOwnProperty.call(patch, "releaseDate")) {
    next.release_date = str(patch.releaseDate, 64)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "genre")) {
    next.genre =
      patch.genre === "" || patch.genre == null
        ? null
        : str(normalizeStoredGenreString(String(patch.genre)), 800)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lyrics")) {
    next.lyrics = str(patch.lyrics, 20000)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "source")) {
    next.source = str(patch.source, 200)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "url")) {
    next.url = str(patch.url, 2000)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "trackNumber")) {
    next.track_number = Number.isFinite(Number(patch.trackNumber))
      ? Number(patch.trackNumber)
      : null
  }
  if (Object.prototype.hasOwnProperty.call(patch, "discNumber")) {
    next.disc_number = Number.isFinite(Number(patch.discNumber))
      ? Number(patch.discNumber)
      : null
  }
  if (Object.prototype.hasOwnProperty.call(patch, "durationMs")) {
    next.duration_ms = Number.isFinite(Number(patch.durationMs))
      ? Number(patch.durationMs)
      : null
  }

  withLibraryDbTransaction(libraryRoot, () => {
    db.prepare(
      `UPDATE tracks SET
        title = @title,
        release_date = @release_date,
        genre = @genre,
        lyrics = @lyrics,
        source = @source,
        url = @url,
        track_number = @track_number,
        disc_number = @disc_number,
        duration_ms = @duration_ms,
        user_edited = 1,
        updated_at = @updated_at
      WHERE rel_path = @rel_path`,
    ).run({
      title: next.title,
      release_date: next.release_date,
      genre: next.genre,
      lyrics: next.lyrics,
      source: next.source,
      url: next.url,
      track_number: next.track_number,
      disc_number: next.disc_number,
      duration_ms: next.duration_ms,
      rel_path: relPath,
      updated_at: Date.now(),
    })

    db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(relPath)
    db.prepare(
      "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
    ).run(
      next.title,
      prev.artist_name,
      prev.album_name,
      next.genre || "",
      relPath,
    )
  })

  bumpLibraryEpoch(libraryRoot)
  const row = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(relPath)
  return {
    title: row?.title || null,
    releaseDate: row?.release_date || null,
    genre: row?.genre || null,
    lyrics: row?.lyrics || null,
    durationMs: row?.duration_ms ?? null,
    trackNumber: row?.track_number ?? null,
    discNumber: row?.disc_number ?? null,
    source: row?.source || null,
    url: row?.url || null,
  }
}

/** @param {string} libraryRoot @param {string} folderRelPath @param {string|null} coverRelPath @param {string|null} coverArtId */
export function patchAlbumCoverInDb(libraryRoot, folderRelPath, coverRelPath, coverArtId = null) {
  const db = getLibraryDb(libraryRoot)
  db.prepare(
    `UPDATE albums SET
      cover_rel_path = @cover_rel_path,
      cover_art_id = COALESCE(@cover_art_id, cover_art_id),
      has_cover = @has_cover,
      updated_at = @updated_at
    WHERE folder_rel_path = @folder_rel_path`,
  ).run({
    cover_rel_path: coverRelPath,
    cover_art_id: coverArtId,
    has_cover: coverRelPath ? 1 : 0,
    folder_rel_path: folderRelPath,
    updated_at: Date.now(),
  })
  bumpLibraryEpoch(libraryRoot)
  const row = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  return albumRowToIndex(row, [])
}

/** Campi album migrabili da JSON sidecar (esclusi ordinamento e trivia). */
const LEGACY_ALBUM_META_KEYS = [
  "title",
  "releaseDate",
  "genre",
  "label",
  "country",
  "musicbrainzReleaseId",
]

function pickLegacyAlbumField(json, field) {
  if (!json || typeof json !== "object") return null
  if (field === "title") return str(json.title || json.name, 500)
  if (field === "releaseDate") return str(json.date || json.releaseDate, 64)
  if (field === "genre") {
    return json.genre ? str(normalizeStoredGenreString(String(json.genre)), 800) : null
  }
  if (field === "label") return str(json.label, 300)
  if (field === "country") return str(json.country, 64)
  if (field === "musicbrainzReleaseId") return str(json.musicbrainzReleaseId, 200)
  return null
}

function albumDbFieldEmpty(row, field) {
  if (!row) return true
  if (field === "title") {
    const t = String(row.title || "").trim()
    const n = String(row.name || "").trim()
    return !t || t === n
  }
  const v = row[field === "releaseDate" ? "release_date" : field === "musicbrainzReleaseId" ? "musicbrainz_release_id" : field]
  return v == null || String(v).trim() === ""
}

/**
 * Porta in DB i metadati album utili dal JSON (solo campi ancora vuoti nel DB).
 * Non importa expectedTracks / expectedTrackCount.
 */
export function mergeLegacyAlbumJsonIntoDb(libraryRoot, folderRelPath, json) {
  if (!json || typeof json !== "object") return { merged: false, fieldCount: 0 }
  const album = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!album || album.user_edited) return { merged: false, fieldCount: 0 }

  const patch = {}
  let fieldCount = 0
  for (const field of LEGACY_ALBUM_META_KEYS) {
    if (!albumDbFieldEmpty(album, field)) continue
    const v = pickLegacyAlbumField(json, field)
    if (v == null || v === "") continue
    if (field === "releaseDate") patch.releaseDate = v
    else if (field === "title") patch.title = v
    else patch[field] = v
    fieldCount += 1
  }
  if (!fieldCount) return { merged: false, fieldCount: 0 }

  const db = getLibraryDb(libraryRoot)
  const next = {
    title: Object.prototype.hasOwnProperty.call(patch, "title")
      ? patch.title
      : album.title,
    release_date: Object.prototype.hasOwnProperty.call(patch, "releaseDate")
      ? patch.releaseDate
      : album.release_date,
    genre: Object.prototype.hasOwnProperty.call(patch, "genre") ? patch.genre : album.genre,
    label: Object.prototype.hasOwnProperty.call(patch, "label") ? patch.label : album.label,
    country: Object.prototype.hasOwnProperty.call(patch, "country") ? patch.country : album.country,
    musicbrainz_release_id: Object.prototype.hasOwnProperty.call(patch, "musicbrainzReleaseId")
      ? patch.musicbrainzReleaseId
      : album.musicbrainz_release_id,
  }
  const displayName =
    next.title && String(next.title).trim()
      ? String(next.title).trim()
      : album.name

  db.prepare(
    `UPDATE albums SET
      title = @title,
      name = @name,
      release_date = @release_date,
      genre = @genre,
      label = @label,
      country = @country,
      musicbrainz_release_id = @musicbrainz_release_id,
      has_album_meta = 1,
      updated_at = @updated_at
    WHERE folder_rel_path = @folder_rel_path AND user_edited = 0`,
  ).run({
    ...next,
    name: displayName,
    folder_rel_path: folderRelPath,
    updated_at: Date.now(),
  })
  bumpLibraryEpoch(libraryRoot)
  return { merged: true, fieldCount }
}

/** Import metadati da backup JSON sidecar nel DB (senza scrivere file). */
export function importLegacyAlbumMetaToDb(libraryRoot, folderRelPath, json) {
  return mergeLegacyAlbumJsonIntoDb(libraryRoot, folderRelPath, json).merged
}

const LEGACY_TRACK_META_KEYS = [
  "title",
  "releaseDate",
  "genre",
  "lyrics",
  "source",
  "url",
  "durationMs",
]

function pickLegacyTrackField(meta, field) {
  if (!meta || typeof meta !== "object") return null
  if (field === "title") return str(meta.title, 500)
  if (field === "releaseDate") return str(meta.releaseDate || meta.date, 64)
  if (field === "genre") {
    return meta.genre ? str(normalizeStoredGenreString(String(meta.genre)), 800) : null
  }
  if (field === "lyrics") return str(meta.lyrics, 20000)
  if (field === "source") return str(meta.source, 200)
  if (field === "url") return str(meta.url, 2000)
  if (field === "durationMs") {
    return Number.isFinite(Number(meta.durationMs)) ? Number(meta.durationMs) : null
  }
  return null
}

function trackDbFieldEmpty(row, field) {
  if (!row) return true
  const col =
    field === "releaseDate"
      ? "release_date"
      : field === "durationMs"
        ? "duration_ms"
        : field
  const v = row[col]
  return v == null || (typeof v === "string" && v.trim() === "")
}

/**
 * Porta in DB i metadati brano utili dal JSON (solo campi ancora vuoti).
 * Non importa trackNumber / discNumber.
 */
export function mergeLegacyTrackMapIntoDb(libraryRoot, folderRelPath, trackMap) {
  if (!trackMap || typeof trackMap !== "object") return { merged: 0 }
  const db = getLibraryDb(libraryRoot)
  const album = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!album) return { merged: 0 }
  let merged = 0
  for (const [fileName, meta] of Object.entries(trackMap)) {
    if (!meta || typeof meta !== "object") continue
    const relPath = `${folderRelPath}/${fileName}`.replace(/\\/g, "/")
    const prev = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(relPath)
    if (!prev || prev.user_edited) continue

    const patch = {}
    for (const field of LEGACY_TRACK_META_KEYS) {
      if (!trackDbFieldEmpty(prev, field)) continue
      const v = pickLegacyTrackField(meta, field)
      if (v == null || v === "") continue
      if (field === "releaseDate") patch.releaseDate = v
      else patch[field] = v
    }
    if (!Object.keys(patch).length) continue

    saveTrackMetaToDb(libraryRoot, relPath, patch)
    merged += 1
  }
  return { merged }
}

/** @param {string} libraryRoot @param {string} folderRelPath @param {Record<string, object>} trackMap */
export function importLegacyTrackMetaMapToDb(libraryRoot, folderRelPath, trackMap) {
  return mergeLegacyTrackMapIntoDb(libraryRoot, folderRelPath, trackMap).merged
}

/** @param {string} libraryRoot @param {string} folderRelPath */
export function clearAlbumOrderingMetaInDb(libraryRoot, folderRelPath) {
  const prev = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!prev) return false
  const db = getLibraryDb(libraryRoot)
  const expectedRows = db
    .prepare("SELECT COUNT(*) AS n FROM album_expected_tracks WHERE album_id = ?")
    .get(prev.id)?.n
  const hadExpected =
    Number(expectedRows) > 0 || prev.expected_track_count != null
  if (!hadExpected) return false

  withLibraryDbTransaction(libraryRoot, () => {
    db.prepare("DELETE FROM album_expected_tracks WHERE album_id = ?").run(prev.id)
    db.prepare("UPDATE albums SET expected_track_count = NULL WHERE id = ?").run(prev.id)
  })
  bumpLibraryEpoch(libraryRoot)
  return true
}

/** @param {string} libraryRoot @param {string} folderRelPath */
export function clearTrackOrderingMetaInAlbumDb(libraryRoot, folderRelPath) {
  const prev = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!prev) return 0
  const db = getLibraryDb(libraryRoot)
  const r = db
    .prepare(
      `UPDATE tracks SET track_number = NULL, disc_number = NULL
       WHERE album_id = ? AND (track_number IS NOT NULL OR disc_number IS NOT NULL)`,
    )
    .run(prev.id)
  if (r.changes > 0) bumpLibraryEpoch(libraryRoot)
  return r.changes
}
