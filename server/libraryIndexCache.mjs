import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"

const CACHE_FILENAME = "library-index.v1.cache.json"
const SCHEMA_VERSION = 1

function cacheFilePath(musicRoot) {
  return path.join(musicRoot, ".kord", CACHE_FILENAME)
}

function isValidIndexPayload(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.musicRoot === "string" &&
    Array.isArray(obj.artists) &&
    Array.isArray(obj.albums) &&
    Array.isArray(obj.tracks) &&
    obj.stats &&
    typeof obj.stats === "object"
  )
}

/**
 * Lettura one-shot della cache legacy per bootstrap SQLite.
 * Non è più aggiornata a runtime (source of truth: rekord.db).
 * @param {string} musicRoot
 */
export async function readLibraryIndexCache(musicRoot) {
  if (process.env.REKORD_INDEX_CACHE === "0") return null
  const p = cacheFilePath(musicRoot)
  if (!existsSync(p)) return null
  try {
    const raw = await fs.readFile(p, "utf8")
    const data = JSON.parse(raw)
    if (data?.schemaVersion !== SCHEMA_VERSION) return null
    if (!isValidIndexPayload(data.index)) return null
    if (path.resolve(String(data.index.musicRoot || "")) !== path.resolve(musicRoot)) {
      return null
    }
    return data.index
  } catch {
    return null
  }
}
