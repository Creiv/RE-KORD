import { buildLibraryIndex } from "../musicLibrary.mjs"
import { readLibraryIndexCache } from "../libraryIndexCache.mjs"
import { isLibraryDbBootstrapped } from "./index.mjs"
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