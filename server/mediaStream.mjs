import path from "path"

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
}

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

/** Header streaming per file audio serviti da /media. */
export function applyMediaFileHeaders(res, filePath, stat) {
  res.setHeader("Content-Type", audioMimeForFilePath(filePath))
  res.setHeader("Accept-Ranges", "bytes")
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
  const etag = mediaFileEtag(stat)
  if (etag) res.setHeader("ETag", etag)
}
