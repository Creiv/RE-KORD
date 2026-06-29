import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ENV_KEYS = ["REKORD_DISCOGS_TOKEN"] as const

vi.mock("./musicRootConfig.mjs", () => ({
  getDiscogsToken: () => process.env.REKORD_DISCOGS_TOKEN || null,
}))

describe("discogsClient", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    vi.resetModules()
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

  it("maps 429 to rate limit", async () => {
    process.env.REKORD_DISCOGS_TOKEN = "ok"
    vi.resetModules()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    )
    const { discogsFetch } = await import("./discogsClient.mjs")
    await expect(discogsFetch("/releases/1")).rejects.toMatchObject({
      code: "DISCOGS_RATE_LIMIT",
    })
  })
})
