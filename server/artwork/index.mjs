import fs from "fs/promises"
import path from "path"
import { existsSync, statSync } from "fs"
import { getLibraryDb } from "../db/index.mjs"
import { rekordArtworkDir } from "../db/paths.mjs"
import { newArtworkId } from "../db/queries/library.mjs"
import { coverCandidates } from "../musicLibrary.mjs"
import { ensureArtworkThumbs } from "./thumbs.mjs"
import { isFfmpegAvailable } from "../ffmpegBin.mjs"

/** Copia solo se il sorgente è cambiato: evita riscritture (e thumb rigenerate) a ogni scan. */
async function copyCoverIfChanged(sourcePath, destPath) {
  try {
    const src = statSync(sourcePath)
    const dst = statSync(destPath)
    if (dst.size === src.size && dst.mtimeMs >= src.mtimeMs) return true
  } catch {
    /* dest assente → copia */
  }
  try {
    await fs.copyFile(sourcePath, destPath)
    return true
  } catch {
    return false
  }
}

/**
 * Registra copertina da file cartella in .kord/artwork/.
 * Copia l'originale e genera thumb 128/256 via ffmpeg (fallback: file originale).
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

  if (!(await copyCoverIfChanged(sourcePath, fullDest))) return null

  const { thumb128, thumb256 } = await ensureArtworkThumbs(
    fullDest,
    artDir,
    artId,
  )

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
    thumb_128_path: thumb128,
    thumb_256_path: thumb256,
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

  const { thumb128, thumb256 } = await ensureArtworkThumbs(
    fullDest,
    artDir,
    artId,
  )

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
    thumb128,
    thumb256,
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

/**
 * Genera le thumb mancanti per artwork già registrate (librerie pre-thumb,
 * dove thumb_128/256 puntano ancora al file full). Best-effort, pensata per
 * girare in background al boot: aggiorna anche albums.updated_at così i client
 * invalidano la cache HTTP (`?v=`) e scaricano la thumb piccola.
 * @param {string} libraryRoot
 */
export async function backfillArtworkThumbs(libraryRoot) {
  if (!isFfmpegAvailable()) return { updated: 0 }
  const root = path.resolve(String(libraryRoot))
  const db = getLibraryDb(root)
  const rows = db
    .prepare(
      "SELECT id, album_id, full_path, thumb_128_path, thumb_256_path FROM artwork",
    )
    .all()
  const artDir = rekordArtworkDir(root)
  await fs.mkdir(artDir, { recursive: true })
  let updated = 0
  for (const row of rows) {
    const fullPath = String(row.full_path || "")
    if (!fullPath || !existsSync(fullPath)) continue
    const needsThumbs =
      !row.thumb_128_path ||
      !row.thumb_256_path ||
      row.thumb_128_path === fullPath ||
      row.thumb_256_path === fullPath ||
      !existsSync(row.thumb_128_path) ||
      !existsSync(row.thumb_256_path)
    if (!needsThumbs) continue
    const { thumb128, thumb256 } = await ensureArtworkThumbs(
      fullPath,
      artDir,
      row.id,
    ).catch(() => ({ thumb128: fullPath, thumb256: fullPath }))
    if (thumb128 === fullPath && thumb256 === fullPath) continue
    const now = Date.now()
    db.prepare(
      "UPDATE artwork SET thumb_128_path = ?, thumb_256_path = ?, updated_at = ? WHERE id = ?",
    ).run(thumb128, thumb256, now, row.id)
    if (row.album_id) {
      db.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").run(
        now,
        row.album_id,
      )
    }
    updated++
  }
  return { updated }
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
