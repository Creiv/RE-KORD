import path from "path"
import { getLibraryDb, bumpLibraryEpoch, withLibraryDbTransaction } from "../index.mjs"
import { normalizeStoredGenreString } from "../../genres.mjs"
import { albumRowToIndex } from "../mappers.mjs"
import {
  resolveTrackIndexRelPath,
  resolveTrackRelPathByAlbumFile,
} from "../../trackPathResolve.mjs"

function str(v, max) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

function serializeDiscogsExtraJson(value) {
  if (value == null) return null
  /** @type {Record<string, unknown>} */
  const compact = { ...value }
  if (JSON.stringify(compact).length > 32000) {
    delete compact.videos
    delete compact.identifiers
    const m = compact.marketplace
    if (m && typeof m === "object") {
      compact.marketplace = {
        lowestPrice: /** @type {Record<string, unknown>} */ (m).lowestPrice ?? null,
        currency: /** @type {Record<string, unknown>} */ (m).currency ?? null,
      }
    }
  }
  let serialized = JSON.stringify(compact)
  if (serialized.length > 32000) serialized = serialized.slice(0, 32000)
  try {
    JSON.parse(serialized)
    return serialized
  } catch {
    return JSON.stringify({ discogsUri: value?.discogsUri || null })
  }
}

const FETCH_ALBUM_MERGE_KEYS = [
  "title",
  "releaseDate",
  "genre",
  "label",
  "country",
  "musicbrainzReleaseId",
]

function albumDbFieldEmpty(row, field) {
  if (!row) return true
  if (field === "title") {
    const t = String(row.title || "").trim()
    const n = String(row.name || "").trim()
    return !t || t === n
  }
  const v =
    row[
      field === "releaseDate"
        ? "release_date"
        : field === "musicbrainzReleaseId"
          ? "musicbrainz_release_id"
          : field
    ]
  return v == null || String(v).trim() === ""
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
        : serializeDiscogsExtraJson(patch.discogsExtra)
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
 * Salva metadati album da fetch automatico o apply Discogs (non imposta user_edited).
 * @param {string} libraryRoot
 * @param {string} folderRelPath
 * @param {Record<string, unknown>} patch
 * @param {{ source?: 'discogs-apply' | 'fetch', db?: import('better-sqlite3').Database, skipEpochBump?: boolean }} [opts]
 */
export function saveAlbumFetchedMetaToDb(libraryRoot, folderRelPath, patch, opts = {}) {
  const db = opts.db || getLibraryDb(libraryRoot)
  const prev = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  if (!prev) throw new Error("Album not found in library database")

  const isDiscogsApply = opts.source === "discogs-apply"
  const respectUserEdit = !isDiscogsApply && prev.user_edited === 1

  /** @type {Record<string, unknown>} */
  const next = {
    title: prev.title,
    release_date: prev.release_date,
    genre: prev.genre,
    label: prev.label,
    country: prev.country,
    musicbrainz_release_id: prev.musicbrainz_release_id,
    discogs_release_id: prev.discogs_release_id,
    discogs_extra_json: prev.discogs_extra_json,
  }

  for (const field of FETCH_ALBUM_MERGE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    if (respectUserEdit && !albumDbFieldEmpty(prev, field)) continue
    if (field === "title") next.title = str(patch.title, 500)
    else if (field === "releaseDate") next.release_date = str(patch.releaseDate, 64)
    else if (field === "genre") {
      next.genre =
        patch.genre === "" || patch.genre == null
          ? null
          : str(normalizeStoredGenreString(String(patch.genre)), 800)
    } else if (field === "label") next.label = str(patch.label, 300)
    else if (field === "country") next.country = str(patch.country, 64)
    else if (field === "musicbrainzReleaseId") {
      next.musicbrainz_release_id = str(patch.musicbrainzReleaseId, 200)
    }
  }

  if (isDiscogsApply || !respectUserEdit) {
    if (Object.prototype.hasOwnProperty.call(patch, "discogsReleaseId")) {
      next.discogs_release_id = Number.isFinite(Number(patch.discogsReleaseId))
        ? Number(patch.discogsReleaseId)
        : null
    }
    if (Object.prototype.hasOwnProperty.call(patch, "discogsExtra")) {
      next.discogs_extra_json =
        patch.discogsExtra == null ? null : serializeDiscogsExtraJson(patch.discogsExtra)
    }
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

  const applyTx = () => {
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
        updated_at = @updated_at
      WHERE folder_rel_path = @folder_rel_path`,
    ).run({
      title: next.title,
      name: displayName,
      release_date: next.release_date,
      genre: next.genre,
      label: next.label,
      country: next.country,
      musicbrainz_release_id: next.musicbrainz_release_id,
      discogs_release_id: next.discogs_release_id,
      discogs_extra_json: next.discogs_extra_json,
      expected_track_count: expectedTrackCount,
      folder_rel_path: folderRelPath,
      updated_at: Date.now(),
    })

    if (isDiscogsApply && Object.prototype.hasOwnProperty.call(patch, "expectedTracks")) {
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
      if (rows.length) {
        expectedTrackCount = rows.filter((r) => r?.title).length
        db.prepare("UPDATE albums SET expected_track_count = ? WHERE id = ?").run(
          expectedTrackCount,
          prev.id,
        )
      }
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
  }

  if (opts.db) applyTx()
  else withLibraryDbTransaction(libraryRoot, applyTx)

  if (!opts.skipEpochBump) bumpLibraryEpoch(libraryRoot)

  const row = getAlbumRowByFolderRel(libraryRoot, folderRelPath)
  const expectedRows = db
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
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Salva metadati traccia da fetch/apply senza marcare user_edited se già editata.
 * @param {string} libraryRoot
 * @param {string} relPath
 * @param {Record<string, unknown>} patch
 * @param {{ db?: import('better-sqlite3').Database, skipEpochBump?: boolean }} [opts]
 */
export function saveTrackFetchedMetaToDb(libraryRoot, relPath, patch, opts = {}) {
  const db = opts.db || getLibraryDb(libraryRoot)
  const resolvedRelPath = resolveTrackIndexRelPath(libraryRoot, relPath)
  const prev = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(resolvedRelPath)
  if (!prev) throw new Error("Track not found in library database")

  const userEdited = prev.user_edited === 1

  /** @type {Record<string, unknown>} */
  const fields = {}
  if (Object.prototype.hasOwnProperty.call(patch, "title") && !userEdited) {
    fields.title = str(patch.title, 500) || prev.title
  }
  if (Object.prototype.hasOwnProperty.call(patch, "releaseDate") && !userEdited) {
    fields.release_date = str(patch.releaseDate, 64)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "genre") && !userEdited) {
    fields.genre =
      patch.genre === "" || patch.genre == null
        ? null
        : str(normalizeStoredGenreString(String(patch.genre)), 800)
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lyrics") && !userEdited) {
    fields.lyrics = str(patch.lyrics, 20000)
  }
  if (!userEdited) {
    if (Object.prototype.hasOwnProperty.call(patch, "source")) {
      fields.source = str(patch.source, 200)
    }
    if (Object.prototype.hasOwnProperty.call(patch, "url")) {
      fields.url = str(patch.url, 2000)
    }
    if (Object.prototype.hasOwnProperty.call(patch, "trackNumber")) {
      fields.track_number = Number.isFinite(Number(patch.trackNumber))
        ? Number(patch.trackNumber)
        : null
    }
    if (Object.prototype.hasOwnProperty.call(patch, "discNumber")) {
      fields.disc_number = Number.isFinite(Number(patch.discNumber))
        ? Number(patch.discNumber)
        : null
    }
    if (Object.prototype.hasOwnProperty.call(patch, "durationMs")) {
      fields.duration_ms = Number.isFinite(Number(patch.durationMs))
        ? Number(patch.durationMs)
        : null
    }
  }

  if (!Object.keys(fields).length) {
    return {
      title: prev.title,
      releaseDate: prev.release_date,
      genre: prev.genre,
      lyrics: prev.lyrics,
      durationMs: prev.duration_ms ?? null,
      trackNumber: prev.track_number ?? null,
      discNumber: prev.disc_number ?? null,
      source: prev.source,
      url: prev.url,
    }
  }

  const next = { ...prev, ...fields }

  const applyTx = () => {
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
        updated_at = @updated_at
      WHERE rel_path = @rel_path AND user_edited = 0`,
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
      rel_path: resolvedRelPath,
      updated_at: Date.now(),
    })

    const row = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(resolvedRelPath)
    if (row) {
      db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(resolvedRelPath)
      db.prepare(
        "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
      ).run(row.title, row.artist_name, row.album_name, row.genre || "", resolvedRelPath)
    }
  }

  if (opts.db) applyTx()
  else withLibraryDbTransaction(libraryRoot, applyTx)

  if (!opts.skipEpochBump) bumpLibraryEpoch(libraryRoot)

  const row = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(resolvedRelPath)
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

/**
 * @param {string} libraryRoot
 * @param {string} relPath track rel path
 * @param {Record<string, unknown>} patch
 */
export function saveTrackMetaToDb(libraryRoot, relPath, patch) {
  const db = getLibraryDb(libraryRoot)
  const resolvedRelPath = resolveTrackIndexRelPath(libraryRoot, relPath)
  const prev = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(resolvedRelPath)
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
    if (next.lyrics) next.lyrics_auto_checked = 0
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lyricsAutoChecked")) {
    next.lyrics_auto_checked = patch.lyricsAutoChecked ? 1 : 0
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
        lyrics_auto_checked = @lyrics_auto_checked,
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
      lyrics_auto_checked: next.lyrics_auto_checked ? 1 : 0,
      source: next.source,
      url: next.url,
      track_number: next.track_number,
      disc_number: next.disc_number,
      duration_ms: next.duration_ms,
      rel_path: resolvedRelPath,
      updated_at: Date.now(),
    })

    db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(resolvedRelPath)
    db.prepare(
      "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
    ).run(
      next.title,
      prev.artist_name,
      prev.album_name,
      next.genre || "",
      resolvedRelPath,
    )
  })

  bumpLibraryEpoch(libraryRoot)
  const row = db.prepare("SELECT * FROM tracks WHERE rel_path = ?").get(resolvedRelPath)
  return {
    title: row?.title || null,
    releaseDate: row?.release_date || null,
    genre: row?.genre || null,
    lyrics: row?.lyrics || null,
    lyricsAutoChecked: Boolean(row?.lyrics_auto_checked),
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
    const relPath = resolveTrackRelPathByAlbumFile(libraryRoot, folderRelPath, fileName)
    if (!relPath) continue
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
