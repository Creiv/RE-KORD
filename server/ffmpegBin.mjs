import { existsSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_FFMPEG_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"

function resolveBundledFfmpegPath() {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  return path.join(__dirname, "bin", name)
}

export function resolveFfmpegPath() {
  const configured = String(process.env.REKORD_FFMPEG_BIN || "").trim()
  if (configured) return configured
  const bundled = resolveBundledFfmpegPath()
  if (existsSync(bundled)) return bundled
  return DEFAULT_FFMPEG_BIN
}

export function isTranscodeAvailable() {
  const configured = String(process.env.REKORD_FFMPEG_BIN || "").trim()
  if (configured && existsSync(configured)) return true
  if (existsSync(resolveBundledFfmpegPath())) return true
  return false
}
