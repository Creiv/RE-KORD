import { spawn } from "child_process"
import { existsSync, statSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { resolveFfmpegPath, isFfmpegAvailable } from "../ffmpegBin.mjs"

export const ARTWORK_THUMB_SIZES = /** @type {const} */ (["128", "256"])

const FFMPEG_TIMEOUT_MS = 20_000

/** Dedup: stessa thumb richiesta in parallelo (scan + backfill) → un solo ffmpeg. */
const inflight = new Map()

export function thumbFileName(artId, size) {
  return `${artId}.${size}.jpg`
}

function runFfmpegScale(sourcePath, destPath, size) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${size}:${size}:force_original_aspect_ratio=decrease,format=yuvj420p`,
      "-q:v",
      "4",
      "-update",
      "1",
      destPath,
    ]
    const child = spawn(resolveFfmpegPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    })
    let err = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* già terminato */
      }
    }, FFMPEG_TIMEOUT_MS)
    child.stderr?.on("data", (chunk) => {
      err += String(chunk)
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && existsSync(destPath)) resolve()
      else reject(new Error(err.trim() || `ffmpeg exit ${code}`))
    })
  })
}

function isThumbFresh(thumbPath, sourceMtimeMs) {
  try {
    const st = statSync(thumbPath)
    return st.size > 0 && st.mtimeMs >= sourceMtimeMs
  } catch {
    return false
  }
}

/**
 * Genera (se mancanti o stale rispetto al sorgente) le thumb 128/256 di una cover.
 * Ritorna i path effettivi da salvare nel DB; su qualsiasi errore torna il
 * fallback (il file originale), quindi mai peggio del comportamento pre-thumb.
 *
 * @param {string} sourcePath file cover originale (già copiato in .kord/artwork o su disco)
 * @param {string} artDir cartella .kord/artwork
 * @param {string} artId id artwork (nome file thumb)
 * @returns {Promise<{ thumb128: string, thumb256: string }>}
 */
export async function ensureArtworkThumbs(sourcePath, artDir, artId) {
  const fallback = { thumb128: sourcePath, thumb256: sourcePath }
  if (!isFfmpegAvailable()) return fallback

  let sourceMtimeMs = 0
  try {
    sourceMtimeMs = statSync(sourcePath).mtimeMs
  } catch {
    return fallback
  }

  const out = { ...fallback }
  for (const size of ARTWORK_THUMB_SIZES) {
    const destPath = path.join(artDir, thumbFileName(artId, size))
    if (isThumbFresh(destPath, sourceMtimeMs)) {
      out[`thumb${size}`] = destPath
      continue
    }
    const key = destPath
    let job = inflight.get(key)
    if (!job) {
      job = runFfmpegScale(sourcePath, destPath, Number(size)).finally(() => {
        inflight.delete(key)
      })
      inflight.set(key, job)
    }
    try {
      await job
      out[`thumb${size}`] = destPath
    } catch {
      // ffmpeg fallito (formato esotico, file corrotto): resta il fallback.
      await fs.rm(destPath, { force: true }).catch(() => {})
    }
  }
  return out
}
