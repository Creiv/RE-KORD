import path from "path"
import { rekordBaseDir } from "../rekordDataStore.mjs"

export const REKORD_DB_FILENAME = "rekord.db"

/** @param {string} libraryRoot */
export function rekordDbPath(libraryRoot) {
  return path.join(rekordBaseDir(libraryRoot), REKORD_DB_FILENAME)
}

/** @param {string} libraryRoot */
export function rekordArtworkDir(libraryRoot) {
  return path.join(rekordBaseDir(libraryRoot), "artwork")
}
