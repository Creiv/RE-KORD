// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const discogsState = { configured: false }
const fetchReleaseMetadataDiscogs = vi.fn()
const fetchDiscogsRelease = vi.fn()

vi.mock("./discogsClient.mjs", () => ({
  isDiscogsConfigured: () => discogsState.configured,
}))

vi.mock("./discogsMetadata.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discogsMetadata.mjs")>()
  return {
    ...actual,
    fetchReleaseMetadataDiscogs: (...args: unknown[]) =>
      fetchReleaseMetadataDiscogs(...args),
    fetchDiscogsRelease: (...args: unknown[]) => fetchDiscogsRelease(...args),
  }
})

vi.mock("./musicRootConfig.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicRootConfig.mjs")>()
  let root = ""
  return {
    ...actual,
    getMusicRoot: () => root,
    __setMusicRoot: (r: string) => {
      root = r
    },
  }
})

describe("albumInfo fetchReleaseMetadata discogs priority", () => {
  const roots: string[] = []

  beforeEach(() => {
    discogsState.configured = false
    fetchReleaseMetadataDiscogs.mockReset()
    fetchDiscogsRelease.mockReset()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    )
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    const { closeLibraryDb } = await import("./db/index.mjs")
    for (const root of roots) {
      closeLibraryDb(root)
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
    roots.length = 0
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

  it("resolveDiscogsAlbumTrackContext uses saved discogsReleaseId", async () => {
    discogsState.configured = true
    const musicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-discogs-ctx-"))
    roots.push(musicRoot)
    await fs.mkdir(path.join(musicRoot, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(musicRoot, "Artist", "Album", "01.flac"), "x")

    const musicRootConfig = await import("./musicRootConfig.mjs")
    ;(musicRootConfig as { __setMusicRoot?: (r: string) => void }).__setMusicRoot?.(
      musicRoot,
    )

    const { buildLibraryIndex } = await import("./musicLibrary.mjs")
    const { persistLibraryIndexToDb } = await import("./db/queries/library.mjs")
    const { saveAlbumFetchedMetaToDb } = await import("./db/queries/metadata.mjs")

    const full = await buildLibraryIndex(musicRoot, { enrichDuration: false })
    await persistLibraryIndexToDb(musicRoot, full)
    saveAlbumFetchedMetaToDb(
      musicRoot,
      "Artist/Album",
      { discogsReleaseId: 42 },
      { source: "discogs-apply" },
    )

    fetchDiscogsRelease.mockResolvedValue({
      ok: true,
      discogsReleaseId: 42,
      expectedTracks: [{ title: "Saved Track" }],
      releaseDate: "2020",
      genre: "Rock",
      discogsUri: "https://discogs.com/release/42",
    })

    const { resolveDiscogsAlbumTrackContext } = await import("./albumInfo.mjs")
    const ctx = await resolveDiscogsAlbumTrackContext(
      path.join(musicRoot, "Artist", "Album"),
      "Artist",
      "Album",
    )
    expect(fetchDiscogsRelease).toHaveBeenCalledWith(42)
    expect(fetchReleaseMetadataDiscogs).not.toHaveBeenCalled()
    expect(ctx?.tracklist?.[0]?.title).toBe("Saved Track")
  })
})
