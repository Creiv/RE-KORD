import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  configureNativePlayback,
  dispatchNativePlaybackEventForTest,
  isNativePlaybackBridgeAvailable,
  nativeCancelSleepFade,
  nativeLoad,
  nativePlay,
  nativeSleepFadeAndPause,
  setNativePlaybackEventHandler,
} from "./nativePlayback"

describe("nativePlayback", () => {
  const configure = vi.fn()
  const load = vi.fn()
  const play = vi.fn()

  beforeEach(() => {
    ;(window as unknown as { RekordNativePlayback?: object }).RekordNativePlayback =
      {
        configure,
        load,
        play,
        pause: vi.fn(),
        seek: vi.fn(),
        stop: vi.fn(),
        cancelSleepFade: vi.fn(),
        sleepFadeAndPause: vi.fn(),
      }
  })

  afterEach(() => {
    delete (window as unknown as { RekordNativePlayback?: object })
      .RekordNativePlayback
    setNativePlaybackEventHandler(null)
    vi.clearAllMocks()
  })

  it("rileva il bridge Android", () => {
    expect(isNativePlaybackBridgeAvailable()).toBe(true)
  })

  it("inoltra configure e load al bridge", () => {
    configureNativePlayback(true)
    nativeLoad("http://192.168.0.1/media/a.mp3", 12, true)
    expect(configure).toHaveBeenCalledWith(true)
    expect(load).toHaveBeenCalledWith(
      "http://192.168.0.1/media/a.mp3",
      12,
      true,
    )
  })

  it("propaga eventi nativi al handler registrato", () => {
    const handler = vi.fn()
    setNativePlaybackEventHandler(handler)
    dispatchNativePlaybackEventForTest({
      type: "timeupdate",
      position: 4,
      duration: 200,
    })
    expect(handler).toHaveBeenCalledWith({
      type: "timeupdate",
      position: 4,
      duration: 200,
    })
    nativePlay()
    expect(play).toHaveBeenCalled()
  })

  it("inoltra sleep fade al bridge nativo", () => {
    const cancelSleepFade = vi.fn()
    const sleepFadeAndPause = vi.fn()
    ;(window as unknown as { RekordNativePlayback?: object }).RekordNativePlayback =
      {
        configure,
        load,
        play,
        pause: vi.fn(),
        seek: vi.fn(),
        stop: vi.fn(),
        cancelSleepFade,
        sleepFadeAndPause,
      }
    nativeSleepFadeAndPause(30)
    nativeCancelSleepFade()
    expect(sleepFadeAndPause).toHaveBeenCalledWith(30)
    expect(cancelSleepFade).toHaveBeenCalled()
  })
})
