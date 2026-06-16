/** Ponte ExoPlayer nativo (APK Android — `RekordNativePlayback` in MainActivity). */

export type NativePlaybackEvent = {
  type: "timeupdate" | "ended" | "playing" | "paused" | "error" | "ready"
  position?: number
  duration?: number
  message?: string
}

type RekordNativePlaybackBridge = {
  configure: (enabled: boolean) => void
  load: (url: string, positionSec: number, autoplay: boolean) => void
  play: () => void
  pause: () => void
  seek: (positionSec: number) => void
  stop: () => void
  cancelSleepFade?: () => void
  sleepFadeAndPause?: (durationSec: number) => void
}

function bridge(): RekordNativePlaybackBridge | null {
  try {
    const w = window as unknown as {
      RekordNativePlayback?: RekordNativePlaybackBridge
    }
    const b = w.RekordNativePlayback
    if (
      b &&
      typeof b.configure === "function" &&
      typeof b.load === "function"
    ) {
      return b
    }
    return null
  } catch {
    return null
  }
}

export function isNativePlaybackBridgeAvailable(): boolean {
  return bridge() !== null
}

let eventHandler: ((event: NativePlaybackEvent) => void) | null = null

export function setNativePlaybackEventHandler(
  handler: ((event: NativePlaybackEvent) => void) | null,
): void {
  eventHandler = handler
  const w = window as unknown as {
    __rekordNativePlaybackEvent?: (event: NativePlaybackEvent) => void
  }
  if (handler) {
    w.__rekordNativePlaybackEvent = (event) => {
      try {
        handler(event)
      } catch {
        /* */
      }
    }
  } else {
    delete w.__rekordNativePlaybackEvent
  }
}

export function configureNativePlayback(enabled: boolean): void {
  bridge()?.configure(enabled)
}

export function nativeLoad(
  url: string,
  positionSec: number,
  autoplay: boolean,
): void {
  bridge()?.load(url, positionSec, autoplay)
}

export function nativePlay(): void {
  bridge()?.play()
}

export function nativePause(): void {
  bridge()?.pause()
}

export function nativeSeek(positionSec: number): void {
  bridge()?.seek(positionSec)
}

export function nativeStop(): void {
  bridge()?.stop()
}

export function nativeCancelSleepFade(): void {
  bridge()?.cancelSleepFade?.()
}

export function nativeSleepFadeAndPause(durationSec: number): void {
  bridge()?.sleepFadeAndPause?.(durationSec)
}

/** Per test: simula evento dal nativo. */
export function dispatchNativePlaybackEventForTest(
  event: NativePlaybackEvent,
): void {
  eventHandler?.(event)
}
