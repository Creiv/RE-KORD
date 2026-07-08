import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { rekordAccountDir } from "./rekordDataStore.mjs"

const THEME_BG_BASENAME = "theme-bg"
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"])
/** Limite upload sfondo tema (GIF animate possono superare i few MB). */
export const THEME_BG_MAX_BYTES = 32 * 1024 * 1024
const MAX_BYTES = THEME_BG_MAX_BYTES

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

function extFromMime(mimeType) {
  const mime = String(mimeType || "").trim().toLowerCase()
  const ext = MIME_TO_EXT[mime]
  return ext && ALLOWED_EXT.has(ext) ? ext : null
}

function extFromFilename(name) {
  const ext = path.extname(String(name || "")).slice(1).toLowerCase()
  if (ext === "jpeg") return "jpg"
  return ALLOWED_EXT.has(ext) ? ext : null
}

/** Riconosce il formato reale dai magic bytes: una GIF salvata con estensione
 *  sbagliata non verrebbe animata dal client (che attiva il layer <img> solo
 *  quando bgImage === "gif"). */
export function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 4) return null
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 &&
    buffer[2] === 0x46 && buffer[3] === 0x38
  ) {
    return "gif" // "GIF8"
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return "png"
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg"
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 &&
    buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "webp" // RIFF....WEBP
  }
  return null
}

function resolveThemeBgExt(buffer, mimeType, originalname) {
  return (
    sniffImageExt(buffer) ||
    extFromMime(mimeType) ||
    extFromFilename(originalname)
  )
}

function themeBgPathInDir(dir, ext) {
  return path.join(dir, `${THEME_BG_BASENAME}.${ext}`)
}

export function findCustomThemeBgPath(libraryRoot, accountId) {
  const dir = rekordAccountDir(libraryRoot, accountId)
  if (!dir || !existsSync(dir)) return null
  for (const ext of ALLOWED_EXT) {
    const normalized = ext === "jpeg" ? "jpg" : ext
    const fp = themeBgPathInDir(dir, normalized)
    if (existsSync(fp)) return fp
  }
  return null
}

export function mediaTypeForThemeBgPath(fp) {
  const ext = path.extname(String(fp || "")).slice(1).toLowerCase()
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "png") return "image/png"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  return "application/octet-stream"
}

async function removeExistingThemeBgFiles(dir) {
  for (const ext of ALLOWED_EXT) {
    const normalized = ext === "jpeg" ? "jpg" : ext
    const fp = themeBgPathInDir(dir, normalized)
    if (!existsSync(fp)) continue
    try {
      await fs.unlink(fp)
    } catch {
      /* ignore */
    }
  }
}

export async function saveCustomThemeBg(libraryRoot, accountId, buffer, mimeType, originalname) {
  const dir = rekordAccountDir(libraryRoot, accountId)
  if (!dir) {
    const e = new Error("Invalid account")
    e.code = "INVALID_ACCOUNT"
    throw e
  }
  if (!buffer?.length || buffer.length > MAX_BYTES) {
    const e = new Error(`Image file too large (max ${THEME_BG_MAX_BYTES / (1024 * 1024)} MB)`)
    e.code = "IMAGE_TOO_LARGE"
    throw e
  }
  const ext = resolveThemeBgExt(buffer, mimeType, originalname)
  if (!ext) {
    const e = new Error("Unsupported image type")
    e.code = "INVALID_IMAGE_TYPE"
    throw e
  }
  await fs.mkdir(dir, { recursive: true })
  await removeExistingThemeBgFiles(dir)
  const target = themeBgPathInDir(dir, ext)
  await fs.writeFile(target, buffer)
  return ext
}

export async function deleteCustomThemeBg(libraryRoot, accountId) {
  const dir = rekordAccountDir(libraryRoot, accountId)
  if (!dir) return false
  let removed = false
  for (const ext of ALLOWED_EXT) {
    const normalized = ext === "jpeg" ? "jpg" : ext
    const fp = themeBgPathInDir(dir, normalized)
    if (!existsSync(fp)) continue
    try {
      await fs.unlink(fp)
      removed = true
    } catch {
      /* ignore */
    }
  }
  return removed
}
