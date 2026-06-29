import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ENV_KEYS = ["REKORD_DISCOGS_TOKEN"] as const

vi.mock("./musicRootConfig.mjs", () => ({
  getDiscogsToken: () => process.env.REKORD_DISCOGS_TOKEN || null,
}))

describe("discogsClient", () => {
  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    vi.resetModules()
    const { resetDiscogsClientForTests } = await import("./discogsClient.mjs")
    resetDiscogsClientForTests()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 1 }),
      })),
    )
  })

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    vi.unstubAllGlobals()
  })

  it("is always configured", async () => {
    const { isDiscogsConfigured } = await import("./discogsClient.mjs")
    expect(isDiscogsConfigured()).toBe(true)
  })

  it("allows unauthenticated fetch without token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1 }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    const { discogsFetch } = await import("./discogsClient.mjs")
    const out = await discogsFetch("/releases/1")
    expect(out.id).toBe(1)
    const headers = fetchMock.mock.calls[0]?.[1]?.headers || {}
    expect(headers.Authorization).toBeUndefined()
  })

  it("maps 401 to unauthorized when token is set", async () => {
    process.env.REKORD_DISCOGS_TOKEN = "bad"
    vi.resetModules()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    )
    const { discogsFetch } = await import("./discogsClient.mjs")
    await expect(discogsFetch("/releases/1")).rejects.toMatchObject({
      code: "DISCOGS_UNAUTHORIZED",
    })
  })

  it("maps 429 to rate limit after retries", async () => {
    process.env.REKORD_DISCOGS_TOKEN = "ok"
    vi.resetModules()
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1
        return {
          ok: false,
          status: 429,
          json: async () => ({}),
          headers: { get: () => "0" },
        }
      }),
    )
    const { discogsFetch, resetDiscogsClientForTests } = await import("./discogsClient.mjs")
    resetDiscogsClientForTests()
    await expect(discogsFetch("/releases/1")).rejects.toMatchObject({
      code: "DISCOGS_RATE_LIMIT",
    })
    expect(calls).toBeGreaterThan(1)
  }, 15000)

  it("serializes parallel discogsFetch calls", async () => {
    vi.resetModules()
    const order: number[] = []
    let n = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const id = ++n
        order.push(id)
        await new Promise((r) => setTimeout(r, 5))
        order.push(-id)
        return { ok: true, status: 200, json: async () => ({ id }) }
      }),
    )
    const { discogsFetch, resetDiscogsClientForTests } = await import(
      "./discogsClient.mjs"
    )
    resetDiscogsClientForTests()
    await Promise.all([discogsFetch("/a"), discogsFetch("/b")])
    expect(order.filter((x) => x > 0)).toEqual([1, 2])
    expect(order).toEqual([1, -1, 2, -2])
  })
})
