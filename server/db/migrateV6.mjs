const LOOSE_SEGMENTS = new Set(["Tracce", "Tracks"])

/**
 * Migrazione v6: allinea album loose ::Tracce → ::Tracks, file_path e rel_path coerenti.
 * @param {import('better-sqlite3').Database} db
 */
export function migrateV6LoosePaths(db) {
  db.pragma("foreign_keys = OFF")
  const tx = db.transaction(() => {
    migrateLooseAlbumIds(db)
    migrateLooseTrackPaths(db)
  })
  tx()
  db.pragma("foreign_keys = ON")
}

function migrateLooseAlbumIds(db) {
  const tracceAlbums = db
    .prepare("SELECT * FROM albums WHERE loose = 1 AND id LIKE '%::Tracce'")
    .all()

  for (const oldAlbum of tracceAlbums) {
    const newId = oldAlbum.id.replace(/::Tracce$/, "::Tracks")
    const existing = db.prepare("SELECT id FROM albums WHERE id = ?").get(newId)

    if (existing && existing.id !== oldAlbum.id) {
      db.prepare("UPDATE tracks SET album_id = ? WHERE album_id = ?").run(newId, oldAlbum.id)
      db.prepare("UPDATE album_expected_tracks SET album_id = ? WHERE album_id = ?").run(
        newId,
        oldAlbum.id,
      )
      db.prepare("UPDATE artwork SET album_id = ? WHERE album_id = ?").run(newId, oldAlbum.id)
      db.prepare("DELETE FROM albums WHERE id = ?").run(oldAlbum.id)
    } else {
      db.prepare("UPDATE tracks SET album_id = ? WHERE album_id = ?").run(newId, oldAlbum.id)
      db.prepare("UPDATE album_expected_tracks SET album_id = ? WHERE album_id = ?").run(
        newId,
        oldAlbum.id,
      )
      db.prepare("UPDATE artwork SET album_id = ? WHERE album_id = ?").run(newId, oldAlbum.id)
      db.prepare("UPDATE albums SET id = ?, name = 'Tracks' WHERE id = ?").run(
        newId,
        oldAlbum.id,
      )
    }
  }
}

/**
 * @param {string} relPath
 * @returns {{ newRelPath: string, newFilePath: string, newAlbumId: string } | null}
 */
export function resolveLooseTrackPaths(relPath) {
  const parts = String(relPath || "")
    .split("/")
    .filter(Boolean)
  if (parts.length < 2) return null

  if (parts.length === 3 && LOOSE_SEGMENTS.has(parts[1])) {
    return {
      newRelPath: `${parts[0]}/Tracks/${parts[2]}`,
      newFilePath: `${parts[0]}/${parts[2]}`,
      newAlbumId: `${parts[0]}::Tracks`,
    }
  }

  if (parts.length === 2) {
    return {
      newRelPath: `${parts[0]}/Tracks/${parts[1]}`,
      newFilePath: `${parts[0]}/${parts[1]}`,
      newAlbumId: `${parts[0]}::Tracks`,
    }
  }

  return null
}

function migrateLooseTrackPaths(db) {
  const looseTracks = db.prepare("SELECT * FROM tracks WHERE loose = 1").all()

  for (const track of looseTracks) {
    const resolved = resolveLooseTrackPaths(track.rel_path)
    let newRelPath = track.rel_path
    let newFilePath = track.file_path || track.rel_path
    let newAlbumId = track.album_id

    if (resolved) {
      newRelPath = resolved.newRelPath
      newFilePath = resolved.newFilePath
      newAlbumId = resolved.newAlbumId
    } else if (track.loose === 1) {
      const parts = track.rel_path.split("/").filter(Boolean)
      if (parts.length === 3 && LOOSE_SEGMENTS.has(parts[1])) {
        newFilePath = `${parts[0]}/${parts[2]}`
      }
    }

    const needsUpdate =
      newRelPath !== track.rel_path ||
      newFilePath !== (track.file_path || track.rel_path) ||
      newAlbumId !== track.album_id ||
      track.id !== newRelPath

    if (!needsUpdate) continue

    const oldRelPath = track.rel_path
    const oldFilePath = track.file_path

    db.prepare("DELETE FROM tracks_fts WHERE rel_path = ?").run(oldRelPath)

    if (oldFilePath && oldFilePath !== newFilePath) {
      const fileRow = db.prepare("SELECT rel_path FROM files WHERE rel_path = ?").get(oldFilePath)
      if (fileRow) {
        db.prepare("DELETE FROM files WHERE rel_path = ?").run(newFilePath)
        db.prepare("UPDATE files SET rel_path = ? WHERE rel_path = ?").run(
          newFilePath,
          oldFilePath,
        )
      }
    }

    db.prepare(
      `UPDATE tracks SET
        id = @newId,
        rel_path = @newRelPath,
        file_path = @newFilePath,
        album_id = @newAlbumId,
        album_name = 'Tracks'
      WHERE rel_path = @oldRelPath`,
    ).run({
      newId: newRelPath,
      newRelPath,
      newFilePath,
      newAlbumId,
      oldRelPath,
    })

    db.prepare(
      "INSERT INTO tracks_fts (title, artist_name, album_name, genre, rel_path) VALUES (?, ?, ?, ?, ?)",
    ).run(track.title, track.artist_name, "Tracks", track.genre || "", newRelPath)
  }
}

/**
 * Varianti path per lookup rimozione incrementale (Tracce ↔ Tracks).
 * @param {string} filePath
 * @returns {string[]}
 */
export function trackPathLookupVariants(filePath) {
  const fp = String(filePath || "").trim()
  if (!fp) return []
  const out = new Set([fp])
  if (fp.includes("/Tracce/")) out.add(fp.replace("/Tracce/", "/Tracks/"))
  if (fp.includes("/Tracks/")) out.add(fp.replace("/Tracks/", "/Tracce/"))
  const parts = fp.split("/").filter(Boolean)
  if (parts.length === 3 && LOOSE_SEGMENTS.has(parts[1])) {
    out.add(`${parts[0]}/${parts[2]}`)
  }
  if (parts.length === 2) {
    out.add(`${parts[0]}/Tracks/${parts[1]}`)
    out.add(`${parts[0]}/Tracce/${parts[1]}`)
  }
  return [...out]
}
