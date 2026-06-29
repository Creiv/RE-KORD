import {
  isGoogleCastSenderAvailable,
  type CastStreamOptions,
} from "./castMedia"
import type { CastTrackPayload } from "./castMedia"
import { isNativeMediaSessionBridgeAvailable } from "./mediaSession"

const CAST_SDK_URL =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
const DEFAULT_RECEIVER_APP_ID = "CC1AD845"

type CastPlaybackCallbacks = {
  onSessionStart: () => void
  onSessionEnd: () => void
  onRequestSync: () => CastTrackPayload | null
}

type CastChrome = {
  cast: {
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: string
      MediaInfo: new (url: string, contentType: string) => CastMediaInfo
      MusicTrackMediaMetadata: new () => CastMusicMetadata
      StreamType: { BUFFERED: string }
      LoadRequest: new (info: CastMediaInfo) => CastLoadRequest
    }
    Image: new (url: string) => { url: string }
    AutoJoinPolicy: { ORIGIN_SCOPED: string }
    SessionRequest: new (appId: string) => unknown
  }
}

type CastMediaInfo = {
  metadata: CastMusicMetadata
  streamType: string
}

type CastMusicMetadata = {
  title: string
  artist: string
  albumName: string
  images: { url: string }[]
}

type CastLoadRequest = {
  currentTime: number
}

type CastSession = {
  loadMedia: (
    request: CastLoadRequest,
    onSuccess: () => void,
    onError: (err: unknown) => void,
  ) => void
}

type CastFrameworkContext = {
  setOptions: (opts: {
    receiverApplicationId: string
    autoJoinPolicy: string
  }) => void
  requestSession: () => Promise<CastSession>
  getCurrentSession: () => CastSession | null
  addEventListener: (
    type: string,
    handler: (ev: { sessionState: string }) => void,
  ) => void
}

type CastFrameworkWindow = Window & {
  cast?: { framework?: { CastContext: { getInstance: () => CastFrameworkContext } } }
  chrome?: CastChrome
  __onGCastApiAvailable?: (available: boolean) => void
}

let sdkLoadPromise: Promise<boolean> | null = null
let castInitialized = false
let castActive = false
let callbacks: CastPlaybackCallbacks | null = null
let lastLoadedMediaId = ""

function castWin(): CastFrameworkWindow {
  return window as CastFrameworkWindow
}

function chromeCast(): CastChrome["cast"] | null {
  return castWin().chrome?.cast ?? null
}

function castContext(): CastFrameworkContext | null {
  try {
    return castWin().cast?.framework?.CastContext.getInstance() ?? null
  } catch {
    return null
  }
}

export function isWebCastActive(): boolean {
  return castActive
}

export function registerCastPlaybackCallbacks(
  cbs: CastPlaybackCallbacks,
): () => void {
  callbacks = cbs
  return () => {
    if (callbacks === cbs) callbacks = null
  }
}

export async function ensureCastSdkLoaded(): Promise<boolean> {
  if (isGoogleCastSenderAvailable()) return true
  if (sdkLoadPromise) return sdkLoadPromise
  sdkLoadPromise = new Promise((resolve) => {
    const finish = (ok: boolean) => resolve(ok)
    castWin().__onGCastApiAvailable = (available) => finish(Boolean(available))
    const existing = document.querySelector(
      `script[src*="cast_sender.js"]`,
    )
    if (existing) {
      window.setTimeout(() => finish(isGoogleCastSenderAvailable()), 500)
      return
    }
    const script = document.createElement("script")
    script.src = CAST_SDK_URL
    script.async = true
    script.onload = () => {
      window.setTimeout(() => finish(isGoogleCastSenderAvailable()), 1500)
    }
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })
  return sdkLoadPromise
}

function initCastContextIfNeeded(): boolean {
  const cc = castContext()
  const chrome = chromeCast()
  if (!cc || !chrome) return false
  if (castInitialized) return true
  cc.setOptions({
    receiverApplicationId:
      chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID || DEFAULT_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.AutoJoinPolicy.ORIGIN_SCOPED,
  })
  cc.addEventListener("sessionstatechanged", (ev) => {
      const ended =
        ev.sessionState === "SESSION_ENDED" ||
        ev.sessionState === "SESSION_START_FAILED"
      const started = ev.sessionState === "SESSION_STARTED"
      if (started && !castActive) {
        castActive = true
        lastLoadedMediaId = ""
        callbacks?.onSessionStart()
        syncWebCastNow()
      } else if (ended && castActive) {
        castActive = false
        lastLoadedMediaId = ""
        callbacks?.onSessionEnd()
      }
    },
  )
  castInitialized = true
  return true
}

function loadPayloadOnSession(session: CastSession, payload: CastTrackPayload): void {
  const chrome = chromeCast()
  if (!chrome) return
  const mediaInfo = new chrome.media.MediaInfo(
    payload.streamUrl,
    payload.mimeType,
  )
  const metadata = new chrome.media.MusicTrackMediaMetadata()
  metadata.title = payload.track.title
  metadata.artist = payload.track.artist
  metadata.albumName = payload.track.album
  metadata.images = [new chrome.Image(payload.coverUrl)]
  mediaInfo.metadata = metadata
  mediaInfo.streamType = chrome.media.StreamType.BUFFERED
  const request = new chrome.media.LoadRequest(mediaInfo)
  request.currentTime = payload.positionSec
  session.loadMedia(
    request,
    () => {
      lastLoadedMediaId = payload.track.relPath
    },
    () => {
      /* receiver error — session may still be valid */
    },
  )
}

export function syncWebCastNow(): void {
  if (!castActive) return
  const payload = callbacks?.onRequestSync()
  if (!payload) return
  const session = castContext()?.getCurrentSession()
  if (!session) return
  if (payload.track.relPath === lastLoadedMediaId) return
  loadPayloadOnSession(session, payload)
}

export async function requestWebCastSession(): Promise<boolean> {
  const loaded = await ensureCastSdkLoaded()
  if (!loaded || !initCastContextIfNeeded()) return false
  const cc = castContext()
  if (!cc) return false
  try {
    const session = await cc.requestSession()
    castActive = true
    lastLoadedMediaId = ""
    callbacks?.onSessionStart()
    const payload = callbacks?.onRequestSync()
    if (payload) loadPayloadOnSession(session, payload)
    return true
  } catch {
    return false
  }
}

export async function endWebCastSession(): Promise<void> {
  const session = castContext()?.getCurrentSession() as
    | (CastSession & { stop: (ok: () => void, err: (e: unknown) => void) => void })
    | null
  if (!session) {
    castActive = false
    callbacks?.onSessionEnd()
    return
  }
  await new Promise<void>((resolve) => {
    session.stop(
      () => resolve(),
      () => resolve(),
    )
  })
  castActive = false
  lastLoadedMediaId = ""
  callbacks?.onSessionEnd()
}

export async function toggleWebCastSession(): Promise<boolean> {
  if (castActive) {
    await endWebCastSession()
    return false
  }
  return requestWebCastSession()
}

export function canUseWebCastSender(): boolean {
  if (typeof window === "undefined") return false
  return !isNativeMediaSessionBridgeAvailable()
}

export type { CastStreamOptions }
