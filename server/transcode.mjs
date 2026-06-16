import { createHash } from "crypto"
import { spawn } from "child_process"
import { existsSync, mkdirSync, statSync } from "fs"
import path from "path"
import { getMusicRoot } from "./musicRootConfig.mjs"
import { hasReservedPathSegment, pathHasParentDirSegment, underRoot } from "./pathSafety.mjs"
import { sendError } from "./httpUtils.mjs"
import { serveMediaFileWithRange } from "./mediaStream.mjs"
import { resolveFfmpegPath, isTranscodeAvailable } from "./ffmpegBin.mjs"

export { isTranscodeAvailable } from "./ffmpegBin.mjs"

/** Formati spesso non decodificati da Google Home / Cast. */
export const CAST_TRANSCODE_EXTS = new Set(["flac", "ogg", "opus", "wav"])

export function needsCastTranscode(relPath) {
  const ext = String(relPath || "").split(".").pop()?.toLowerCase() ?? ""
  return CAST_TRANSCODE_EXTS.has(ext)
}

const transcodeInflight = new Map()

function transcodeCacheDir(libraryRoot) {
  return path.join(libraryRoot, ".kord", "transcode-cache")
}

function cacheKey(relPath, format, bitrate, mtimeMs) {
  return createHash("sha256")
    .update(`${relPath}\0${format}\0${bitrate}\0${mtimeMs}`)
    .digest("hex")
}

function cachedOutputPath(libraryRoot, relPath, format, bitrate, mtimeMs) {
  const key = cacheKey(relPath, format, bitrate, mtimeMs)
  const ext = format === "aac" ? "m4a" : "mp3"
  return path.join(transcodeCacheDir(libraryRoot), `${key}.${ext}`)
}

function parseTranscodeQuery(req) {
  const formatRaw = String(req.query.format || "mp3").toLowerCase()
  const format = formatRaw === "aac" ? "aac" : "mp3"
  const bitrate = Math.min(
    320,
    Math.max(64, Number.parseInt(String(req.query.bitrate || "192"), 10) || 192),
  )
  return { format, bitrate }
}

function runFfmpeg(inputPath, outputPath, format, bitrate) {
  return new Promise((resolve, reject) => {
    const args =
      format === "aac"
        ? [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            `${bitrate}k`,
            outputPath,
          ]
        : [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            `${bitrate}k`,
            outputPath,
          ]
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    child.stderr?.on("data", (chunk) => {
      err += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0 && existsSync(outputPath)) resolve()
      else reject(new Error(err.trim() || `ffmpeg exit ${code}`))
    })
  })
}

async function ensureTranscodedFile(libraryRoot, sourcePath, relPath, format, bitrate, mtimeMs) {
  const outPath = cachedOutputPath(libraryRoot, relPath, format, bitrate, mtimeMs)
  if (existsSync(outPath)) {
    const st = statSync(outPath)
    if (st.size > 0) return outPath
  }
  mkdirSync(transcodeCacheDir(libraryRoot), { recursive: true })
  const key = outPath
  let inflight = transcodeInflight.get(key)
  if (!inflight) {
    inflight = runFfmpeg(sourcePath, outPath, format, bitrate).finally(() => {
      transcodeInflight.delete(key)
    })
    transcodeInflight.set(key, inflight)
  }
  await inflight
  return outPath
}

export function registerTranscodeRoutes(app) {
  app.use("/media/transcode", async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).end()
      return
    }
    try {
      if (!isTranscodeAvailable()) {
        return sendError(res, 503, "Transcoding unavailable", {
          details: { code: "TRANSCODE_UNAVAILABLE" },
        })
      }
      const root = getMusicRoot()
      if (!root) return sendError(res, 503, "Library not configured")
      const relPath = decodeURIComponent(String(req.path || "").replace(/^\/+/, ""))
      if (
        !relPath ||
        pathHasParentDirSegment(relPath) ||
        hasReservedPathSegment(relPath)
      ) {
        return sendError(res, 400, "Invalid path")
      }
      const sourcePath = path.join(root, relPath.replaceAll("/", path.sep))
      if (!underRoot(sourcePath, root) || !existsSync(sourcePath)) {
        return sendError(res, 404, "File not found")
      }
      const st = statSync(sourcePath)
      if (!st.isFile()) return sendError(res, 404, "File not found")
      const { format, bitrate } = parseTranscodeQuery(req)
      const outPath = await ensureTranscodedFile(
        root,
        sourcePath,
        relPath,
        format,
        bitrate,
        st.mtimeMs,
      )
      const outStat = statSync(outPath)
      return serveMediaFileWithRange(req, res, outPath, outStat)
    } catch (error) {
      console.error("[rekord] transcode:", error?.message || error)
      if (!res.headersSent) {
        return sendError(res, 500, String(error?.message || error))
      }
      res.end()
    }
  })
}
