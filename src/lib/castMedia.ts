import { mediaUrl } from "./api"
import type { EnrichedTrack } from "../types"

/** Estensioni audio servite da /media con MIME tipico per Google Cast. */
const CAST_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase()
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
}

/**
 * Base URL raggiungibile dal Chromecast / Google Home sulla LAN.
 * Il dispositivo Cast non può aprire localhost del telefono/PC: serve l'IP LAN
 * del server (o un tunnel HTTPS pubblico).
 */
export function resolveCastMediaBaseUrl(options: {
  pageOrigin: string
  lanAccessUrl?: string | null
  remotePublicUrl?: string | null
}): string | null {
  try {
    const page = new URL(options.pageOrigin)
    if (!isLoopbackHostname(page.hostname)) return page.origin
    if (options.lanAccessUrl) return new URL(options.lanAccessUrl).origin
    if (options.remotePublicUrl) return new URL(options.remotePublicUrl).origin
    return null
  } catch {
    return null
  }
}

export function castMimeTypeForRelPath(relPath: string): string {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? ""
  return CAST_MIME_BY_EXT[ext] ?? "audio/mpeg"
}

/** Formati spesso non decodificati da Google Home / Cast. */
export const CAST_TRANSCODE_EXTS = new Set(["flac", "ogg", "opus", "wav"])

export type CastStreamOptions = {
  /** Usa /media/transcode per formati non compatibili con Cast. */
  forCast?: boolean
  /** Se false, non usa transcode anche in forCast (es. ffmpeg assente). */
  transcodeAvailable?: boolean
}

function encodeMediaRelPath(relPath: string): string {
  return relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

export function transcodeMediaPath(relPath: string, format = "mp3"): string {
  const base = encodeMediaRelPath(relPath)
  const params = new URLSearchParams({ format })
  return `/media/transcode/${base}?${params}`
}

export function needsCastTranscodeRelPath(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? ""
  return CAST_TRANSCODE_EXTS.has(ext)
}

export function castStreamUrl(
  relPath: string,
  baseOrigin: string,
  opts: CastStreamOptions = {},
): string {
  const forCast = opts.forCast === true
  const transcodeOk = opts.transcodeAvailable !== false
  if (forCast && transcodeOk && needsCastTranscodeRelPath(relPath)) {
    return new URL(transcodeMediaPath(relPath), baseOrigin).href
  }
  return new URL(mediaUrl(relPath), baseOrigin).href
}

export function castCoverUrl(
  relPath: string,
  baseOrigin: string,
): string {
  const params = new URLSearchParams({ path: relPath })
  return new URL(`/api/cover?${params}`, baseOrigin).href
}

export type CastTrackPayload = {
  streamUrl: string
  coverUrl: string
  mimeType: string
  track: EnrichedTrack
  positionSec: number
}

export function buildCastTrackPayload(
  track: EnrichedTrack,
  baseOrigin: string,
  positionSec = 0,
  opts: CastStreamOptions = {},
): CastTrackPayload {
  const streamUrl = castStreamUrl(track.relPath, baseOrigin, opts)
  return {
    track,
    streamUrl,
    coverUrl: castCoverUrl(track.relPath, baseOrigin),
    mimeType: castMimeTypeForRelPath(
      streamUrl.includes("/media/transcode/") ? "x.mp3" : track.relPath,
    ),
    positionSec: Math.max(0, positionSec),
  }
}

/** Chrome desktop/Android e PWA installata da Chrome; non WebView/Capacitor/Electron. */
export function isGoogleCastSenderAvailable(): boolean {
  if (typeof window === "undefined") return false
  const w = window as Window & { cast?: { framework?: unknown } }
  return Boolean(w.cast?.framework)
}
