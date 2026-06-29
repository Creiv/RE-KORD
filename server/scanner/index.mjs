import path from "path"
import { getLibraryDb } from "../db/index.mjs"
import {
  persistIncrementalToDb,
  persistLibraryIndexToDb,
} from "../db/queries/library.mjs"
import { bootstrapLibraryDb } from "../db/bootstrap.mjs"
import { runScanEngine } from "./engine.mjs"

/** @type {Map<string, Promise<void>>} */
const scanFlight = new Map()

/** @type {Map<string, boolean>} */
const scanningFlags = new Map()

/** @type {Map<string, Set<string>>} */
const pendingPaths = new Map()

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounceTimers = new Map()

export function isLibraryScanning(libraryRoot) {
  return Boolean(scanningFlags.get(path.resolve(String(libraryRoot || ""))))
}

/**
 * @param {string} libraryRoot
 * @param {{ full?: boolean, paths?: string[], enrichDuration?: boolean, readTags?: boolean }} opts
 */
export async function runLibraryScan(libraryRoot, opts = {}) {
  const key = path.resolve(String(libraryRoot || ""))
  let inflight = scanFlight.get(key)
  if (inflight) return inflight

  scanningFlags.set(key, true)
  inflight = (async () => {
    try {
      if (!opts.full) {
        const bootstrapped = await bootstrapLibraryDb(libraryRoot)
        if (bootstrapped) return
      }

      const result = await runScanEngine(libraryRoot, opts)
      if (result.mode === "noop" || !result.index) return

      if (result.mode === "full") {
        await persistLibraryIndexToDb(libraryRoot, result.index)
        const db = getLibraryDb(libraryRoot)
        db.prepare("UPDATE library_state SET last_incremental_at = ? WHERE id = 1").run(
          new Date().toISOString(),
        )
      } else {
        await persistIncrementalToDb(libraryRoot, result.index, {
          removedPaths: result.removedPaths,
        })
      }

      if (result.stats) {
        console.log(
          `[rekord] library scan: ${result.mode} (+${result.stats.added ?? 0} ~${result.stats.unchanged ?? 0} -${result.stats.removed ?? 0})`,
        )
      }
    } finally {
      scanningFlags.delete(key)
    }
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
 * @param {{ full?: boolean, paths?: string[], debounceMs?: number, enrichDuration?: boolean, readTags?: boolean }} opts
 */
export function scheduleLibraryScan(libraryRoot, opts = {}) {
  const key = path.resolve(String(libraryRoot || ""))
  if (opts.paths?.length) {
    const set = pendingPaths.get(key) || new Set()
    for (const p of opts.paths) set.add(p)
    pendingPaths.set(key, set)
  }

  const prev = debounceTimers.get(key)
  if (prev) clearTimeout(prev)
  const ms = Number(opts.debounceMs) || 800
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key)
      const paths = pendingPaths.has(key) ? [...pendingPaths.get(key)] : opts.paths
      pendingPaths.delete(key)
      void runLibraryScan(libraryRoot, { ...opts, paths }).catch((err) => {
        console.error("[rekord] library scan:", err?.message || err)
      })
    }, ms),
  )
}

export async function invalidateAndScanLibrary(libraryRoot, opts = {}) {
  scheduleLibraryScan(libraryRoot, { ...opts, full: opts.full ?? false })
}
