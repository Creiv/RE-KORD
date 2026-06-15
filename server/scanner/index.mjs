import path from "path"
import { buildLibraryIndex } from "../musicLibrary.mjs"
import { bumpLibraryEpoch, getLibraryDb } from "../db/index.mjs"
import { persistLibraryIndexToDb } from "../db/queries/library.mjs"
import { bootstrapLibraryDb } from "../db/bootstrap.mjs"

/** @type {Map<string, Promise<void>>} */
const scanFlight = new Map()

/**
 * Full rescan: rebuild index from filesystem and persist to SQLite.
 * @param {string} libraryRoot
 * @param {{ full?: boolean }} opts
 */
export async function runLibraryScan(libraryRoot, opts = {}) {
  const key = path.resolve(String(libraryRoot || ""))
  let inflight = scanFlight.get(key)
  if (inflight) return inflight

  inflight = (async () => {
    if (!opts.full) {
      const bootstrapped = await bootstrapLibraryDb(libraryRoot)
      if (bootstrapped) return
    }
    const index = await buildLibraryIndex(libraryRoot)
    await persistLibraryIndexToDb(libraryRoot, index)
    const db = getLibraryDb(libraryRoot)
    db.prepare(
      "UPDATE library_state SET last_incremental_at = ?, last_full_scan_at = ? WHERE id = 1",
    ).run(new Date().toISOString(), new Date().toISOString())
    bumpLibraryEpoch(libraryRoot)
  })()

  scanFlight.set(key, inflight)
  try {
    await inflight
  } finally {
    if (scanFlight.get(key) === inflight) scanFlight.delete(key)
  }
}

/**
 * @param {string} libraryRoot
 * @param {{ full?: boolean, debounceMs?: number }} opts
 */
export function scheduleLibraryScan(libraryRoot, opts = {}) {
  scheduleLibraryScanDebounced(libraryRoot, opts)
}

const debounceTimers = new Map()

function scheduleLibraryScanDebounced(libraryRoot, opts) {
  const key = path.resolve(String(libraryRoot || ""))
  const prev = debounceTimers.get(key)
  if (prev) clearTimeout(prev)
  const ms = Number(opts.debounceMs) || 800
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key)
      void runLibraryScan(libraryRoot, opts).catch((err) => {
        console.error("[rekord] library scan:", err?.message || err)
      })
    }, ms),
  )
}

export async function invalidateAndScanLibrary(libraryRoot, opts = {}) {
  scheduleLibraryScan(libraryRoot, { ...opts, full: opts.full ?? true })
}
