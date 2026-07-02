import { createReadStream } from "fs"
import path from "path"
import { isCloudflareTunnelRequest } from "./requestAccess.mjs"

/**
 * Pipe di un read stream verso la response con gestione errori: senza
 * handler, un errore I/O (o un client disconnesso) emette un "error"
 * non catturato che può abbattere il processo.
 */
function pipeStreamToResponse(stream, res) {
  stream.on("error", () => {
    stream.destroy()
    if (!res.headersSent) res.status(500)
    res.end()
  })
  res.on("close", () => stream.destroy())
  return stream.pipe(res)
}

/** MIME audio per estensione — cast, browser e ExoPlayer. */
export const AUDIO_MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
}

/** Lossless di grandi dimensioni: seek via Range, critico su tunnel Cloudflare. */
export const LOSSLESS_STREAM_EXTS = new Set(["flac", "wav", "aiff", "aif"])

export function audioMimeForFilePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  return AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream"
}

export function mediaFileEtag(stat) {
  if (!stat) return null
  const size = Number(stat.size) || 0
  const mtime = Math.floor(Number(stat.mtimeMs) || 0)
  return `"${size.toString(16)}-${mtime.toString(16)}"`
}

export function mediaInitialRangeChunkBytes() {
  const n = Number.parseInt(
    String(process.env.REKORD_MEDIA_INITIAL_RANGE_BYTES ?? "1048576"),
    10,
  )
  return Number.isFinite(n) && n > 0 ? n : 1_048_576
}

export function mediaRangeHintThresholdBytes() {
  const n = Number.parseInt(
    String(process.env.REKORD_MEDIA_RANGE_HINT_THRESHOLD_BYTES ?? "4194304"),
    10,
  )
  return Number.isFinite(n) && n > 0 ? n : 4_194_304
}

export function isLosslessMediaPath(filePath) {
  const ext = path.extname(String(filePath || ""))
    .slice(1)
    .toLowerCase()
  return LOSSLESS_STREAM_EXTS.has(ext)
}

/**
 * @param {string | undefined} rangeHeader
 * @param {number} fileSize
 * @returns {{ start: number, end: number } | { invalid: true } | null}
 */
export function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader || !Number.isFinite(fileSize) || fileSize <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim())
  if (!m) return null

  const hasStart = m[1] !== ""
  const hasEnd = m[2] !== ""
  if (!hasStart && !hasEnd) return null

  if (hasStart && hasEnd) {
    const start = Number.parseInt(m[1], 10)
    const end = Number.parseInt(m[2], 10)
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      return { invalid: true }
    }
    return { start, end: Math.min(end, fileSize - 1) }
  }

  if (hasStart) {
    const start = Number.parseInt(m[1], 10)
    if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
      return { invalid: true }
    }
    return { start, end: fileSize - 1 }
  }

  const suffix = Number.parseInt(m[2], 10)
  if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
  if (suffix >= fileSize) return { start: 0, end: fileSize - 1 }
  return { start: fileSize - suffix, end: fileSize - 1 }
}

/**
 * Su tunnel Cloudflare, un GET senza Range su FLAC grandi può bloccare il proxy.
 * Rispondiamo con il primo chunk (206) così il client usa Range per seek.
 * @param {import("express").Request} req
 */
export function shouldServeInitialRangeOnly(req, filePath, stat) {
  if (req.method !== "GET" && req.method !== "HEAD") return false
  if (req.headers.range) return false
  if (!isLosslessMediaPath(filePath)) return false
  if (!stat || stat.size <= mediaRangeHintThresholdBytes()) return false
  if (isCloudflareTunnelRequest(req)) return true
  return process.env.REKORD_MEDIA_INITIAL_RANGE_ALWAYS === "1"
}

/** Header streaming per file audio serviti da /media. */
export function applyMediaFileHeaders(res, filePath, stat, req = null) {
  res.setHeader("Content-Type", audioMimeForFilePath(filePath))
  res.setHeader("Accept-Ranges", "bytes")
  res.setHeader("Vary", "Range")
  if (req && isCloudflareTunnelRequest(req)) {
    res.setHeader("Cache-Control", "private, no-transform, max-age=3600")
  } else {
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
  }
  const etag = mediaFileEtag(stat)
  if (etag) res.setHeader("ETag", etag)
}

/**
 * Serve un file locale con supporto Range completo (inclusi suffix e open-ended).
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export function serveMediaFileWithRange(req, res, filePath, stat) {
  applyMediaFileHeaders(res, filePath, stat, req)

  const etag = mediaFileEtag(stat)
  const ifNoneMatch = req.headers["if-none-match"]
  if (etag && ifNoneMatch === etag && !req.headers.range) {
    return res.status(304).end()
  }

  if (shouldServeInitialRangeOnly(req, filePath, stat)) {
    const chunk = mediaInitialRangeChunkBytes()
    const end = Math.min(stat.size - 1, chunk - 1)
    res.status(206)
    res.setHeader("Content-Range", `bytes 0-${end}/${stat.size}`)
    res.setHeader("Content-Length", end + 1)
    if (req.method === "HEAD") return res.end()
    return pipeStreamToResponse(createReadStream(filePath, { start: 0, end }), res)
  }

  const parsed = parseByteRange(req.headers.range, stat.size)
  if (parsed && "invalid" in parsed) {
    res.status(416)
    res.setHeader("Content-Range", `bytes */${stat.size}`)
    return res.end()
  }

  if (parsed) {
    res.status(206)
    res.setHeader(
      "Content-Range",
      `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
    )
    res.setHeader("Content-Length", parsed.end - parsed.start + 1)
    if (req.method === "HEAD") return res.end()
    return pipeStreamToResponse(
      createReadStream(filePath, { start: parsed.start, end: parsed.end }),
      res,
    )
  }

  res.setHeader("Content-Length", stat.size)
  if (req.method === "HEAD") return res.status(200).end()
  return pipeStreamToResponse(createReadStream(filePath), res)
}
