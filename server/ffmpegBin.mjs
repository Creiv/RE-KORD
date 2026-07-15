import { existsSync } from "fs"
import { spawnSync } from "child_process"

import { resolveBundledBinPath } from "./bundledBin.mjs"

const DEFAULT_FFMPEG_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"

function bundledFilename() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
}

function resolveBundledFfmpegPath() {
  return resolveBundledBinPath(bundledFilename())
}

export function resolveFfmpegPath() {
  const configured = String(process.env.REKORD_FFMPEG_BIN || "").trim()
  if (configured) return configured
  const bundled = resolveBundledFfmpegPath()
  if (bundled) return bundled
  return DEFAULT_FFMPEG_BIN
}

export function isTranscodeAvailable() {
  const configured = String(process.env.REKORD_FFMPEG_BIN || "").trim()
  if (configured && existsSync(configured)) return true
  if (resolveBundledFfmpegPath()) return true
  return false
}

/** Cache della probe `ffmpeg -version` sul PATH (null = mai provato). */
let ffmpegOnPathProbe = null

/**
 * Come isTranscodeAvailable ma accetta anche ffmpeg nel PATH di sistema
 * (tipico in dev/Linux). Usato per le thumbnail delle cover.
 */
export function isFfmpegAvailable() {
  if (isTranscodeAvailable()) return true
  if (ffmpegOnPathProbe === null) {
    try {
      const res = spawnSync(DEFAULT_FFMPEG_BIN, ["-version"], {
        stdio: "ignore",
        timeout: 3000,
      })
      ffmpegOnPathProbe = res.status === 0
    } catch {
      ffmpegOnPathProbe = false
    }
  }
  return ffmpegOnPathProbe
}
