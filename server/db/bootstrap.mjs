import { buildLibraryIndex } from "../musicLibrary.mjs"
import { readLibraryIndexCache } from "../libraryIndexCache.mjs"
import { isLibraryDbBootstrapped, getLibraryDb } from "./index.mjs"
import { persistLibraryIndexToDb } from "./queries/library.mjs"

/**
 * Bootstrap iniziale del DB da cache JSON o scan filesystem completo.
 * @param {string} libraryRoot
 */
export async function bootstrapLibraryDb(libraryRoot) {
  if (isLibraryDbBootstrapped(libraryRoot)) return false

  let index = await readLibraryIndexCache(libraryRoot)
  if (!index) {
    index = await buildLibraryIndex(libraryRoot)
  }

  await persistLibraryIndexToDb(libraryRoot, index)
  return true
}

/** @param {string} libraryRoot */
export function ensureLibraryDbReady(libraryRoot) {
  getLibraryDb(libraryRoot)
  if (!isLibraryDbBootstrapped(libraryRoot)) {
    throw new Error("Library database not bootstrapped")
  }
}
