import path from "path"
import { existsSync, statSync } from "fs"
import { getMusicRoot, isLibraryRootConfigured } from "./musicRootConfig.mjs"
import {
  hasReservedPathSegment,
  pathHasParentDirSegment,
  underRoot,
} from "./pathSafety.mjs"
import { serveMediaFileWithRange } from "./mediaStream.mjs"

/**
 * /media/* con Range esplicito (sostituisce express.static per seek FLAC su tunnel).
 */
export function registerMediaRoutes(app) {
  app.use("/media", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).end()
      return
    }
    const sub = String(req.path || "")
    if (sub.startsWith("/transcode")) return next()

    if (!isLibraryRootConfigured()) {
      res.status(503).end()
      return
    }
    const root = getMusicRoot()
    if (!root) {
      res.status(503).end()
      return
    }

    const relPath = decodeURIComponent(sub.replace(/^\/+/, ""))
    if (
      !relPath ||
      pathHasParentDirSegment(relPath) ||
      hasReservedPathSegment(relPath)
    ) {
      res.status(404).end()
      return
    }

    const filePath = path.join(root, relPath.replaceAll("/", path.sep))
    if (!underRoot(filePath, root) || !existsSync(filePath)) {
      res.status(404).end()
      return
    }

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      res.status(404).end()
      return
    }
    if (!stat.isFile()) {
      res.status(404).end()
      return
    }

    try {
      return serveMediaFileWithRange(req, res, filePath, stat)
    } catch (error) {
      console.error("[rekord] media:", error?.message || error)
      if (!res.headersSent) res.status(500).end()
      else res.end()
    }
  })
}
