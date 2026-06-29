import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const discogsState = { configured: false }
const fetchReleaseMetadataDiscogs = vi.fn()

vi.mock("./discogsClient.mjs", () => ({
  isDiscogsConfigured: () => discogsState.configured,
}))

vi.mock("./discogsMetadata.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discogsMetadata.mjs")>()
  return {
    ...actual,
    fetchReleaseMetadataDiscogs: (...args: unknown[]) =>
      fetchReleaseMetadataDiscogs(...args),
  }
})

describe("albumInfo fetchReleaseMetadata discogs priority", () => {
  beforeEach(() => {
    discogsState.configured = false
    fetchReleaseMetadataDiscogs.mockReset()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("skips Discogs when token is not configured", async () => {
    const { fetchReleaseMetadata } = await import("./albumInfo.mjs")
    const out = await fetchReleaseMetadata("Artist", "Album")
    expect(fetchReleaseMetadataDiscogs).not.toHaveBeenCalled()
    expect(out.error).toBeTruthy()
  })

  it("returns Discogs payload when configured and MB is unavailable", async () => {
    discogsState.configured = true
    fetchReleaseMetadataDiscogs.mockResolvedValue({
      ok: true,
      source: "discogs",
      discogsReleaseId: 99,
      label: "Discogs Label",
      expectedTracks: [{ title: "One" }],
      expectedTrackCount: 1,
    })

    const { fetchReleaseMetadata } = await import("./albumInfo.mjs")
    const out = await fetchReleaseMetadata("Artist", "Album")
    expect(fetchReleaseMetadataDiscogs).toHaveBeenCalledWith("Artist", "Album")
    expect(out.ok).toBe(true)
    expect(out.discogsReleaseId).toBe(99)
    expect(out.label).toBe("Discogs Label")
  })
})
