import chokidar from "chokidar"
import path from "path"
import { scheduleLibraryScan } from "./index.mjs"

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

  const watcher = chokidar.watch(libraryRoot, {
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])\../,
      /[/\\]\.kord[/\\]/,
      /[/\\]node_modules[/\\]/,
    ],
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
  })

  const trigger = (eventPath) => {
    scheduleLibraryScan(libraryRoot, {
      paths: [String(eventPath || "")],
      debounceMs: 5000,
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
