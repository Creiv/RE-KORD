import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("api core backoff/retry", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("markApiUnreachable blocks apiFetch until backoff expires", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const {
      BackendUnreachableError,
      apiFetch,
      getApiUnreachableUntilForTests,
      markApiUnreachable,
      resetBackendConnectivityState,
    } = await import("./core")

    resetBackendConnectivityState()
    markApiUnreachable()

    const until = getApiUnreachableUntilForTests()
    expect(until).toBeGreaterThan(Date.now())

    expect(() => apiFetch("/api/config")).toThrow(BackendUnreachableError)
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(12_001)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: {}, error: null }), {
        status: 200,
      }),
    )
    await expect(apiFetch("/api/accounts")).resolves.toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("assertApiReachable throws BackendUnreachableError during backoff window", async () => {
    const {
      BackendUnreachableError,
      assertApiReachable,
      markApiUnreachable,
      resetBackendConnectivityState,
    } = await import("./core")

    resetBackendConnectivityState()
    markApiUnreachable()

    expect(() => assertApiReachable()).toThrow(BackendUnreachableError)
  })

  it("resetBackendConnectivityState clears backoff so requests proceed", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const {
      BackendUnreachableError,
      apiFetch,
      markApiUnreachable,
      resetBackendConnectivityState,
    } = await import("./core")

    resetBackendConnectivityState()
    markApiUnreachable()
    expect(() => apiFetch("/api/config")).toThrow(BackendUnreachableError)

    resetBackendConnectivityState()
    await expect(apiFetch("/api/health")).resolves.toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("apiFetch marks unreachable on network failure and blocks subsequent calls", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const {
      BackendUnreachableError,
      apiFetch,
      resetBackendConnectivityState,
    } = await import("./core")

    resetBackendConnectivityState()

    await expect(apiFetch("/api/config")).rejects.toBeInstanceOf(TypeError)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    expect(() => apiFetch("/api/config")).toThrow(BackendUnreachableError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
