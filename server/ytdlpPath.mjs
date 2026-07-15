import { resolveBundledBinPath } from "./bundledBin.mjs"

function bundledFilename() {
  if (process.platform === "win32") return "yt-dlp.exe"
  return "yt-dlp"
}

export function resolveYtdlpPath() {
  const fromEnv = process.env.YTDLP_PATH
  if (fromEnv != null && String(fromEnv).trim() !== "") return String(fromEnv).trim()
  const bundled = resolveBundledBinPath(bundledFilename())
  if (bundled) return bundled
  return "yt-dlp"
}
