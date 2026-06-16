import fs from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { getLibraryDb } from "../db/index.mjs"
import { rekordArtworkDir } from "../db/paths.mjs"
import { newArtworkId } from "../db/queries/library.mjs"
import { getMusicRoot } from "../musicRootConfig.mjs"
import { coverCandidates } from "../musicLibrary.mjs"

let sharpModule = null
/** @type {Promise<import("sharp").default | null> | null} */
let sharpLoadPromise = null

async function loadSharp() {
  if (sharpModule) return sharpModule
  if (!sharpLoadPromise) {
    sharpLoadPromise = import("sharp")
      .then((mod) => {
        sharpModule = mod.default
        return sharpModule
      })
      .catch((err) => {
        console.error("[rekord] sharp non disponibile:", err?.message || err)
        return null
      })
  }
  return sharpLoadPromise
}

/**
 * Registra copertina da file cartella e genera thumbnail in .kord/artwork/.
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
  const thumb128 = path.join(artDir, `${artId}-128.${ext}`)
  const thumb256 = path.join(artDir, `${artId}-256.${ext}`)

  const sharp = await loadSharp()
  if (!sharp) return null

  try {
    await fs.copyFile(sourcePath, fullDest)
    await sharp(fullDest)
      .resize(128, 128, { fit: "cover" })
      .toFile(thumb128)
    await sharp(fullDest)
      .resize(256, 256, { fit: "cover" })
      .toFile(thumb256)
  } catch {
    return null
  }

  const meta = await sharp(fullDest).metadata().catch(() => ({}))
  const now = Date.now()
  db.prepare(
    `INSERT INTO artwork (id, album_id, kind, mime, width, height, full_path, thumb_128_path, thumb_256_path, updated_at)
     VALUES (@id, @album_id, 'folder', @mime, @width, @height, @full_path, @thumb_128_path, @thumb_256_path, @updated_at)
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
    width: meta.width || null,
    height: meta.height || null,
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
  const thumb128 = path.join(artDir, `${artId}-128.${safeExt}`)
  const thumb256 = path.join(artDir, `${artId}-256.${safeExt}`)

  const sharp = await loadSharp()
  if (!sharp) return null

  await fs.writeFile(fullDest, imageBuffer)
  await sharp(fullDest).resize(128, 128, { fit: "cover" }).toFile(thumb128)
  await sharp(fullDest).resize(256, 256, { fit: "cover" }).toFile(thumb256)

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

/** @param {string} artworkId @param {'128'|'256'|'full'} size */
export function resolveArtworkFilePath(libraryRoot, artworkId, size = "128") {
  const row = getLibraryDb(libraryRoot)
    .prepare("SELECT full_path, thumb_128_path, thumb_256_path FROM artwork WHERE id = ?")
    .get(String(artworkId || ""))
  if (!row) return null
  if (size === "full") return row.full_path
  if (size === "256") return row.thumb_256_path || row.full_path
  return row.thumb_128_path || row.thumb_256_path || row.full_path
}
