import path from "path"
import { existsSync, statSync } from "fs"
import { getMusicRoot, isLibraryRootConfigured } from "./musicRootConfig.mjs"
import {
  hasReservedPathSegment,
  pathHasParentDirSegment,
  realPathUnderRoot,
  underRoot,
} from "./pathSafety.mjs"
import { resolveTrackFileRelPath } from "./scanner/engine.mjs"
import { serveMediaFileWithRange } from "./mediaStream.mjs"
import { validateMediaAccess } from "./mediaAccess.mjs"

/**
 * /media/* con Range esplicito (sostituisce express.static per seek FLAC su tunnel).
 */
export function registerMediaRoutes(app) {
  app.use("/media", async (req, res, next) => {
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

    const mediaRel = resolveTrackFileRelPath(root, relPath)
    const filePath = path.join(root, mediaRel.replaceAll("/", path.sep))
    if (
      !underRoot(filePath, root) ||
      !existsSync(filePath) ||
      !realPathUnderRoot(filePath, root)
    ) {
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

    const access = await validateMediaAccess(req, mediaRel)
    if (!access.ok) {
      res.status(access.status ?? 403).end()
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
