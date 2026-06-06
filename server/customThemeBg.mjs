import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { rekordAccountDir } from "./rekordDataStore.mjs"

export const THEME_BG_BASENAME = "theme-bg"
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"])
const MAX_BYTES = 8 * 1024 * 1024

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

export function extFromMime(mimeType) {
  const mime = String(mimeType || "").trim().toLowerCase()
  const ext = MIME_TO_EXT[mime]
  return ext && ALLOWED_EXT.has(ext) ? ext : null
}

export function sanitizeBgImageExt(raw) {
  if (raw == null || raw === "") return null
  const s = String(raw).trim().toLowerCase()
  if (s === "jpeg") return "jpg"
  if (ALLOWED_EXT.has(s)) return s === "jpeg" ? "jpg" : s
  return null
}

export function sanitizeBgImageRev(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
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

export async function saveCustomThemeBg(libraryRoot, accountId, buffer, mimeType) {
  const dir = rekordAccountDir(libraryRoot, accountId)
  if (!dir) {
    const e = new Error("Invalid account")
    e.code = "INVALID_ACCOUNT"
    throw e
  }
  const ext = extFromMime(mimeType)
  if (!ext) {
    const e = new Error("Unsupported image type")
    e.code = "INVALID_IMAGE_TYPE"
    throw e
  }
  if (!buffer?.length || buffer.length > MAX_BYTES) {
    const e = new Error("Image file too large (max 8 MB)")
    e.code = "IMAGE_TOO_LARGE"
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
