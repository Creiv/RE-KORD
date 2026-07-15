import chokidar from "chokidar"
import path from "path"
import { scheduleLibraryScan, isLibraryScanning } from "./index.mjs"

/** @type {Map<string, import('chokidar').FSWatcher>} */
const watchers = new Map()

/**
 * Avvia watcher filesystem sulla libreria (scan incrementale mirato).
 * @param {string} libraryRoot
 */
export function startLibraryWatcher(libraryRoot) {
  const key = path.resolve(String(libraryRoot || ""))
  if (watchers.has(key)) return

  if (process.env.REKORD_FS_WATCH === "0") return

  const maxWatchDepth = Number(process.env.REKORD_WATCH_DEPTH) || 0

  const watcher = chokidar.watch(libraryRoot, {
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])\../,
      /[/\\]\.kord[/\\]/,
      /[/\\]node_modules[/\\]/,
    ],
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
    depth: maxWatchDepth > 0 ? maxWatchDepth : undefined,
  })

  const trigger = (eventPath) => {
    const rel = path.relative(libraryRoot, String(eventPath || ""))
    if (maxWatchDepth > 0) {
      const depth = rel.split(/[/\\]/).filter(Boolean).length
      if (depth > maxWatchDepth) return
    }
    scheduleLibraryScan(libraryRoot, {
      paths: [String(eventPath || "")],
      debounceMs: isLibraryScanning(libraryRoot) ? 8000 : 5000,
    })
  }

  watcher.on("add", trigger)
  watcher.on("change", trigger)
  watcher.on("unlink", trigger)
  watcher.on("addDir", trigger)
  watcher.on("unlinkDir", trigger)

  watchers.set(key, watcher)
}

/** @param {string} libraryRoot */
export function stopLibraryWatcher(libraryRoot) {
  const key = path.resolve(String(libraryRoot || ""))
  const w = watchers.get(key)
  if (!w) return
  void w.close()
  watchers.delete(key)
}

/** Chiude tutti i watcher attivi (shutdown del processo). */
export function watcherCount() {
  return watchers.size
}

export function stopAllLibraryWatchers() {
  for (const w of watchers.values()) void w.close()
  watchers.clear()
}
