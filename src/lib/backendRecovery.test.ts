import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  onBackendRecovery,
  runBackendRecovery,
  scheduleBackendRecovery,
} from "./backendRecovery"

describe("backendRecovery", () => {
  const unsubs: Array<() => void> = []

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    unsubs.length = 0
  })

  afterEach(() => {
    unsubs.splice(0).forEach((off) => off())
    vi.useRealTimers()
  })

  it("notifies listeners after a successful health probe", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const { resetBackendConnectivityState } = await import("./api")
    resetBackendConnectivityState()

    const heard: string[] = []
    unsubs.push(
      onBackendRecovery((reason) => {
        heard.push(reason)
      }),
    )

    const ok = await runBackendRecovery("manual")
    expect(ok).toBe(true)
    expect(heard).toEqual(["manual"])
    expect(fetchMock).toHaveBeenCalled()
  })

  it("debounces scheduled recovery", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const heard: string[] = []
    unsubs.push(
      onBackendRecovery((reason) => {
        heard.push(reason)
      }),
    )

    scheduleBackendRecovery("resume", 300)
    scheduleBackendRecovery("resume", 300)
    await vi.advanceTimersByTimeAsync(299)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await vi.runAllTimersAsync()
    expect(heard).toEqual(["resume"])
  })
})
