import { getLibraryDb } from "./db/index.mjs"

/**
 * `rel_path` canonico in libreria (lookup per rel_path o file_path su disco).
 * @param {string} libraryRoot
 * @param {string} relPathHint
 */
export function resolveTrackIndexRelPath(libraryRoot, relPathHint) {
  const hint = String(relPathHint || "").trim()
  if (!hint) return null
  const db = getLibraryDb(libraryRoot)
  const row = db
    .prepare(
      `SELECT rel_path FROM tracks
       WHERE rel_path = ? OR file_path = ?
       LIMIT 1`,
    )
    .get(hint, hint)
  return row?.rel_path || hint
}

/**
 * Risolve rel_path da cartella album su disco + nome file.
 * @param {string} libraryRoot
 * @param {string} folderRel
 * @param {string} fileName
 */
export function resolveTrackRelPathByAlbumFile(libraryRoot, folderRel, fileName) {
  const folder = String(folderRel || "").trim()
  const file = String(fileName || "").trim()
  if (!folder || !file) return null
  const db = getLibraryDb(libraryRoot)
  const row = db
    .prepare(
      `SELECT t.rel_path FROM tracks t
       INNER JOIN albums a ON a.id = t.album_id
       WHERE a.folder_rel_path = ? AND t.file_name = ?
       LIMIT 1`,
    )
    .get(folder, file)
  if (row?.rel_path) return row.rel_path
  return resolveTrackIndexRelPath(libraryRoot, `${folder}/${file}`)
}
