import fs from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { getLibraryDb } from "../db/index.mjs"
import { rekordArtworkDir } from "../db/paths.mjs"
import { newArtworkId } from "../db/queries/library.mjs"
import { coverCandidates } from "../musicLibrary.mjs"

/**
 * Registra copertina da file cartella in .kord/artwork/.
 * Copia l'originale; le entry thumb puntano allo stesso file (ridimensionato via CSS).
 * @param {string} libraryRoot
 * @param {string} albumId
 * @param {string} coverRelPath
 */
export async function registerFolderCoverArtwork(libraryRoot, albumId, coverRelPath) {
  const root = path.resolve(String(libraryRoot))
  const rel = String(coverRelPath || "").replace(/\\/g, "/")
  if (!rel) return null

  let sourcePath = path.join(root, rel.replaceAll("/", path.sep))
  if (!existsSync(sourcePath)) {
    const albumFolder = path.dirname(sourcePath)
    for (const name of coverCandidates()) {
      const cand = path.join(albumFolder, name)
      if (existsSync(cand)) {
        sourcePath = cand
        break
      }
    }
  }
  if (!existsSync(sourcePath)) return null

  const artDir = rekordArtworkDir(root)
  await fs.mkdir(artDir, { recursive: true })

  const db = getLibraryDb(root)
  const existing = db
    .prepare("SELECT id FROM artwork WHERE album_id = ? AND kind = 'folder' LIMIT 1")
    .get(albumId)
  const artId = existing?.id || newArtworkId()

  const ext = path.extname(sourcePath).toLowerCase() === ".png" ? "png" : "jpg"
  const fullDest = path.join(artDir, `${artId}.${ext}`)

  try {
    await fs.copyFile(sourcePath, fullDest)
  } catch {
    return null
  }

  const now = Date.now()
  db.prepare(
    `INSERT INTO artwork (id, album_id, kind, mime, full_path, thumb_128_path, thumb_256_path, updated_at)
     VALUES (@id, @album_id, 'folder', @mime, @full_path, @thumb_128_path, @thumb_256_path, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       album_id=excluded.album_id,
       full_path=excluded.full_path,
       thumb_128_path=excluded.thumb_128_path,
       thumb_256_path=excluded.thumb_256_path,
       updated_at=excluded.updated_at`,
  ).run({
    id: artId,
    album_id: albumId,
    mime: ext === "png" ? "image/png" : "image/jpeg",
    full_path: fullDest,
    thumb_128_path: fullDest,
    thumb_256_path: fullDest,
    updated_at: now,
  })

  db.prepare(
    "UPDATE albums SET cover_art_id = ?, has_cover = 1, updated_at = ? WHERE id = ?",
  ).run(artId, now, albumId)

  const albumRow = db.prepare("SELECT artist_id FROM albums WHERE id = ?").get(albumId)
  if (albumRow?.artist_id) {
    db.prepare(
      "UPDATE artists SET cover_art_id = COALESCE(cover_art_id, ?), cover_rel_path = COALESCE(cover_rel_path, ?) WHERE id = ?",
    ).run(artId, rel, albumRow.artist_id)
  }

  return artId
}

/**
 * @param {string} libraryRoot
 * @param {string} albumFolderRel
 * @param {Buffer} imageBuffer
 * @param {string} ext
 */
export async function registerDownloadedCoverArtwork(
  libraryRoot,
  albumFolderRel,
  imageBuffer,
  ext = "jpg",
) {
  const root = path.resolve(String(libraryRoot))
  const db = getLibraryDb(root)
  const album = db
    .prepare("SELECT id FROM albums WHERE folder_rel_path = ? LIMIT 1")
    .get(String(albumFolderRel || "").replace(/\\/g, "/"))
  if (!album) return null

  const artDir = rekordArtworkDir(root)
  await fs.mkdir(artDir, { recursive: true })
  const artId = newArtworkId()
  const safeExt = ext === "png" ? "png" : "jpg"
  const fullDest = path.join(artDir, `${artId}.${safeExt}`)

  await fs.writeFile(fullDest, imageBuffer)

  const coverRelPath = `${albumFolderRel}/cover.${safeExt}`.replace(/\\/g, "/")
  const now = Date.now()
  db.prepare(
    `INSERT INTO artwork (id, album_id, kind, mime, full_path, thumb_128_path, thumb_256_path, updated_at)
     VALUES (?, ?, 'fetched', ?, ?, ?, ?, ?)`,
  ).run(
    artId,
    album.id,
    safeExt === "png" ? "image/png" : "image/jpeg",
    fullDest,
    fullDest,
    fullDest,
    now,
  )
  db.prepare(
    "UPDATE albums SET cover_art_id = ?, cover_rel_path = ?, has_cover = 1, updated_at = ? WHERE id = ?",
  ).run(artId, coverRelPath, now, album.id)
  return { artId, coverRelPath }
}

function firstExistingPath(paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** @param {string} artworkId @param {'128'|'256'|'full'} size */
export function resolveArtworkFilePath(libraryRoot, artworkId, size = "128") {
  const row = getLibraryDb(libraryRoot)
    .prepare("SELECT full_path, thumb_128_path, thumb_256_path FROM artwork WHERE id = ?")
    .get(String(artworkId || ""))
  if (!row) return null
  if (size === "full") {
    return firstExistingPath([row.full_path, row.thumb_256_path, row.thumb_128_path])
  }
  if (size === "256") {
    return firstExistingPath([row.thumb_256_path, row.full_path, row.thumb_128_path])
  }
  return firstExistingPath([row.thumb_128_path, row.thumb_256_path, row.full_path])
}
