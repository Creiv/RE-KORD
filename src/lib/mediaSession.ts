import { coverUrlForTrackRelPath } from "./api"
import type { EnrichedTrack } from "../types"

/** Risoluzioni tipiche richieste da widget OS, Android Auto e desktop. */
export const MEDIA_SESSION_ARTWORK_SIZES = [
  "96x96",
  "128x128",
  "192x192",
  "256x256",
  "384x384",
  "512x512",
] as const

export function buildMediaSessionArtwork(
  coverUrl: string,
  mimeType = "image/jpeg",
): MediaImage[] {
  return MEDIA_SESSION_ARTWORK_SIZES.map((sizes) => ({
    src: coverUrl,
    sizes,
    type: mimeType,
  }))
}

function toAbsoluteUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  if (typeof window === "undefined") return path
  return new URL(path, window.location.origin).href
}

export function canUseMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator
}

let cachedMetadataKey: string | null = null

function metadataCacheKey(track: EnrichedTrack): string {
  const version = (track as EnrichedTrack & { updatedAt?: number | null }).updatedAt
  return `${track.relPath}:${Math.floor(version ?? 0)}`
}

export function setMediaSessionMetadata(
  track: EnrichedTrack | null,
): void {
  if (!canUseMediaSession()) return
  if (!track) {
    cachedMetadataKey = null
    navigator.mediaSession.metadata = null
    return
  }
  const key = metadataCacheKey(track)
  if (cachedMetadataKey === key) return
  cachedMetadataKey = key
  const version = (track as EnrichedTrack & { updatedAt?: number | null }).updatedAt
  const baseCover = coverUrlForTrackRelPath(track.relPath)
  const cover = toAbsoluteUrl(
    version
      ? `${baseCover}${baseCover.includes("?") ? "&" : "?"}v=${Math.floor(version)}`
      : baseCover,
  )
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: buildMediaSessionArtwork(cover),
  })
  if (typeof Image !== "undefined") {
    const warm = new Image()
    warm.decoding = "async"
    warm.src = cover
  }
}

export function setMediaSessionPlaybackState(
  state: "none" | "paused" | "playing",
): void {
  if (!canUseMediaSession()) return
  navigator.mediaSession.playbackState = state
}

export function setMediaSessionPosition(
  duration: number,
  position: number,
  playbackRate = 1,
): void {
  if (!canUseMediaSession()) return
  if (!("setPositionState" in navigator.mediaSession)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  const pos = Math.max(0, Math.min(position, duration))
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate,
      position: pos,
    })
  } catch {
    /* */
  }
}

export type MediaSessionSync = {
  track: EnrichedTrack | null
  playbackState: "none" | "paused" | "playing"
  duration?: number
  position?: number
  playbackRate?: number
  /** Salta setPositionState (es. cambio brano in corso su Android). */
  skipPosition?: boolean
}

export function syncMediaSessionState(sync: MediaSessionSync): void {
  if (!canUseMediaSession()) return
  if (!sync.track) {
    setMediaSessionMetadata(null)
    setMediaSessionPlaybackState("none")
    return
  }
  setMediaSessionMetadata(sync.track)
  setMediaSessionPlaybackState(sync.playbackState)
  if (sync.skipPosition) return
  if (
    sync.duration != null &&
    sync.position != null &&
    Number.isFinite(sync.duration) &&
    sync.duration > 0
  ) {
    setMediaSessionPosition(
      sync.duration,
      sync.position,
      sync.playbackRate ?? 1,
    )
  }
}

/** In Android Auto il mute da volante spesso arriva come pause: meglio silenziare che fermare. */
export function resolveMediaSessionPauseAction(options: {
  isAutomotive: boolean
  isPlaying: boolean
  isMuted: boolean
}): "mute" | "pause" {
  if (options.isAutomotive && options.isMuted) return "pause"
  if (options.isAutomotive && options.isPlaying) return "mute"
  return "pause"
}

export type MediaSessionBridge = {
  play: () => void
  pause: () => void
  mute: () => void
  unmute: () => void
  next: () => void
  prev: () => void
  seek: (timeSec: number) => void
  seekBy: (deltaSec: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  toggleFavoriteCurrent: () => void
  toggleExcludeCurrent: () => void
}

const EXPERIMENTAL_SHUFFLE_ALIASES = [
  "toggleshuffle",
  "shuffle",
] as const

const EXPERIMENTAL_REPEAT_ALIASES = [
  "switchrepeatmode",
  "repeat",
  "setrepeatmode",
  "togglerepeat",
] as const

const EXPERIMENTAL_FAVORITE_ALIASES = [
  "togglelike",
  "like",
  "favorite",
  "togglefavorite",
] as const

const EXPERIMENTAL_EXCLUDE_ALIASES = [
  "toggleshuffleexclude",
  "toggleexcludetrack",
] as const

const EXPERIMENTAL_MUTE_ALIASES = [
  "mute",
  "setmute",
  "volume-mute",
  "volumemute",
] as const

const EXPERIMENTAL_UNMUTE_ALIASES = [
  "unmute",
  "setunmute",
  "volume-unmute",
  "volumeunmute",
] as const

function trySetActionHandler(
  ms: MediaSession,
  action: string,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    ms.setActionHandler(action as MediaSessionAction, handler)
  } catch {
    /* */
  }
}

export function registerMediaSessionActions(
  getBridge: () => MediaSessionBridge,
): () => void {
  if (!canUseMediaSession()) return () => {
    /* */
  }
  const ms = navigator.mediaSession
  const run = (fn: () => void) => {
    try {
      fn()
    } catch {
      /* */
    }
  }
  const play = () => run(() => getBridge().play())
  const pause = () => run(() => getBridge().pause())
  const mute = () => run(() => getBridge().mute())
  const unmute = () => run(() => getBridge().unmute())
  const next = () => run(() => getBridge().next())
  const prev = () => run(() => getBridge().prev())

  const safe = (action: MediaSessionAction, h: (() => void) | null) => {
    try {
      ms.setActionHandler(action, h)
    } catch {
      /* */
    }
  }
  const seekto: MediaSessionAction = "seekto"
  const seekback: MediaSessionAction = "seekbackward"
  const seekforw: MediaSessionAction = "seekforward"

  safe("play", play)
  safe("pause", pause)
  safe("stop", pause)
  safe("previoustrack", prev)
  safe("nexttrack", next)
  try {
    ms.setActionHandler(seekto, (d) => {
      if (d.seekTime == null || !Number.isFinite(d.seekTime)) return
      getBridge().seek(d.seekTime)
    })
  } catch {
    /* */
  }
  try {
    ms.setActionHandler(
      seekback,
      (d) => {
        const off = d.seekOffset ?? 10
        getBridge().seekBy(-off)
      },
    )
  } catch {
    /* */
  }
  try {
    ms.setActionHandler(
      seekforw,
      (d) => {
        const off = d.seekOffset ?? 10
        getBridge().seekBy(off)
      },
    )
  } catch {
    /* */
  }

  const toggleShuffle = () => run(() => getBridge().toggleShuffle())
  const cycleRepeat = () => run(() => getBridge().cycleRepeat())
  const toggleFavorite = () => run(() => getBridge().toggleFavoriteCurrent())
  const toggleExclude = () => run(() => getBridge().toggleExcludeCurrent())

  for (const a of EXPERIMENTAL_SHUFFLE_ALIASES) {
    trySetActionHandler(ms, a, toggleShuffle)
  }
  for (const a of EXPERIMENTAL_REPEAT_ALIASES) {
    trySetActionHandler(ms, a, cycleRepeat)
  }
  for (const a of EXPERIMENTAL_FAVORITE_ALIASES) {
    trySetActionHandler(ms, a, toggleFavorite)
  }
  for (const a of EXPERIMENTAL_EXCLUDE_ALIASES) {
    trySetActionHandler(ms, a, toggleExclude)
  }
  for (const a of EXPERIMENTAL_MUTE_ALIASES) {
    trySetActionHandler(ms, a, mute)
  }
  for (const a of EXPERIMENTAL_UNMUTE_ALIASES) {
    trySetActionHandler(ms, a, unmute)
  }

  return () => {
    safe("play", null)
    safe("pause", null)
    safe("stop", null)
    safe("previoustrack", null)
    safe("nexttrack", null)
    try {
      ms.setActionHandler(seekto, null)
    } catch {
      /* */
    }
    try {
      ms.setActionHandler(seekback, null)
    } catch {
      /* */
    }
    try {
      ms.setActionHandler(seekforw, null)
    } catch {
      /* */
    }
    for (const a of EXPERIMENTAL_SHUFFLE_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
    for (const a of EXPERIMENTAL_REPEAT_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
    for (const a of EXPERIMENTAL_FAVORITE_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
    for (const a of EXPERIMENTAL_EXCLUDE_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
    for (const a of EXPERIMENTAL_MUTE_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
    for (const a of EXPERIMENTAL_UNMUTE_ALIASES) {
      trySetActionHandler(ms, a, null)
    }
  }
}
