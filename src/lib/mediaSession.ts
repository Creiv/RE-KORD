import { castCoverUrl, castStreamUrl } from "./castMedia"
import { coverUrlForTrackRelPath } from "./api"
import type { EnrichedTrack } from "../types"

/** Finestra coda esposta al sistema (Cast / Assistant / Android Auto). */
export const MEDIA_SESSION_QUEUE_WINDOW = 25

export type MediaSessionQueueEntry = {
  id: string
  /** Indice globale nella coda del player (per onSkipToQueueItem). */
  queueId: number
  title: string
  artist: string
  album: string
  mediaUri: string
  artworkUrl: string
}

export function resolveMediaSessionBaseOrigin(): string {
  if (typeof window === "undefined") return ""
  return window.location.origin
}

/** Coda scorrevole centrata sul brano corrente per skip e voice control. */
export function buildMediaSessionQueueEntries(
  queue: readonly EnrichedTrack[],
  currentIndex: number,
  baseOrigin: string,
  castOpts: { forCast?: boolean; transcodeAvailable?: boolean } = {},
): { entries: MediaSessionQueueEntry[]; activeIndex: number } {
  if (!queue.length || !baseOrigin) {
    return { entries: [], activeIndex: 0 }
  }
  const clampedIndex = Math.max(0, Math.min(currentIndex, queue.length - 1))
  const lookBehind = 5
  const start = Math.max(0, clampedIndex - lookBehind)
  const end = Math.min(queue.length, start + MEDIA_SESSION_QUEUE_WINDOW)
  const slice = queue.slice(start, end)
  return {
    entries: slice.map((track, offset) => ({
      id: track.relPath,
      queueId: start + offset,
      title: track.title,
      artist: track.artist,
      album: track.album,
      mediaUri: castStreamUrl(track.relPath, baseOrigin, {
        forCast: castOpts.forCast ?? true,
        transcodeAvailable: castOpts.transcodeAvailable,
      }),
      artworkUrl: castCoverUrl(track.relPath, baseOrigin),
    })),
    activeIndex: clampedIndex - start,
  }
}

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

function canUseMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator
}

/** Client Android (APK): il WebView non ha l'API Media Session — MainActivity
 *  espone un ponte minimale (`RekordMediaNative.update(json)` per lo stato,
 *  `window.__rekordMediaAction(action, seekTime)` per i comandi) collegato
 *  alla MediaSession nativa di RekordMediaService. */
type RekordMediaNative = { update: (json: string) => void }

function rekordMediaNative(): RekordMediaNative | null {
  try {
    const w = window as unknown as { RekordMediaNative?: RekordMediaNative }
    return w.RekordMediaNative &&
      typeof w.RekordMediaNative.update === "function"
      ? w.RekordMediaNative
      : null
  } catch {
    return null
  }
}

function coverUrlForTrack(track: EnrichedTrack): string {
  const version = (track as EnrichedTrack & { updatedAt?: number | null })
    .updatedAt
  const baseCover = coverUrlForTrackRelPath(track.relPath)
  return toAbsoluteUrl(
    version
      ? `${baseCover}${baseCover.includes("?") ? "&" : "?"}v=${Math.floor(version)}`
      : baseCover,
  )
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
  const cover = coverUrlForTrack(track)
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

function setMediaSessionPlaybackState(
  state: "none" | "paused" | "playing",
): void {
  if (!canUseMediaSession()) return
  navigator.mediaSession.playbackState = state
}

function setMediaSessionPosition(
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
  /** URI assoluto del file audio (Google Cast / output picker). */
  mediaUri?: string
  mediaId?: string
  queue?: MediaSessionQueueEntry[]
  queueIndex?: number
  hasPrevious?: boolean
  hasNext?: boolean
}

export function syncMediaSessionState(sync: MediaSessionSync): void {
  const native = rekordMediaNative()
  if (native) {
    try {
      if (!sync.track) {
        native.update(JSON.stringify({ playbackState: "none" }))
        return
      }
      native.update(
        JSON.stringify({
          title: sync.track.title,
          artist: sync.track.artist,
          album: sync.track.album,
          artworkUrl: coverUrlForTrack(sync.track),
          mediaUri: sync.mediaUri ?? "",
          mediaId: sync.mediaId ?? sync.track.relPath,
          playbackState: sync.playbackState,
          skipPosition: sync.skipPosition ?? false,
          duration:
            !sync.skipPosition &&
            sync.duration != null &&
            Number.isFinite(sync.duration) &&
            sync.duration > 0
              ? sync.duration
              : 0,
          position:
            !sync.skipPosition && sync.position != null ? sync.position : 0,
          playbackRate: sync.playbackRate ?? 1,
          queueIndex: sync.queueIndex ?? 0,
          hasPrevious: sync.hasPrevious ?? false,
          hasNext: sync.hasNext ?? false,
          queue: (sync.queue ?? []).map((item) => ({
            id: item.id,
            queueId: item.queueId,
            title: item.title,
            artist: item.artist,
            album: item.album,
            mediaUri: item.mediaUri,
            artworkUrl: item.artworkUrl,
          })),
        }),
      )
    } catch {
      /* */
    }
    return
  }
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
  playQueueIndex: (index: number) => void
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
  const run = (fn: () => void) => {
    try {
      fn()
    } catch {
      /* */
    }
  }

  if (rekordMediaNative()) {
    const target = window as unknown as {
      __rekordMediaAction?: (action: string, seekTime: number) => void
    }
    target.__rekordMediaAction = (action: string, seekTime: number) => {
      run(() => {
        const b = getBridge()
        switch (action) {
          case "play":
            b.play()
            break
          case "pause":
          case "stop":
            b.pause()
            break
          case "nexttrack":
            b.next()
            break
          case "previoustrack":
            b.prev()
            break
          case "playqueueindex":
            if (Number.isFinite(seekTime) && seekTime >= 0) {
              b.playQueueIndex(Math.floor(seekTime))
            }
            break
          case "mute":
            b.mute()
            break
          case "unmute":
            b.unmute()
            break
          case "seekto":
            if (Number.isFinite(seekTime) && seekTime >= 0) b.seek(seekTime)
            break
        }
      })
    }
    return () => {
      delete target.__rekordMediaAction
    }
  }

  if (!canUseMediaSession()) return () => {
    /* */
  }
  const ms = navigator.mediaSession
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
  }
}
