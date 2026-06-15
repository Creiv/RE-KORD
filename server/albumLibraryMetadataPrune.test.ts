// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import { pruneAlbumLibraryMetadataInAlbumDir } from "./albumInfo.mjs"

describe("pruneAlbumLibraryMetadataInAlbumDir", () => {
  it("clears ordering metadata from json sidecars", async () => {
    const albumDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-prune-meta-"))
    await fs.writeFile(path.join(albumDir, "01.flac"), "x")
    await fs.writeFile(path.join(albumDir, "02.flac"), "y")
    await fs.writeFile(
      path.join(albumDir, "kord-albuminfo.json"),
      JSON.stringify({
        title: "Album",
        expectedTracks: [{ disc: 1, position: 1, title: "One" }],
        expectedTrackCount: 1,
      }),
    )
    await fs.writeFile(
      path.join(albumDir, "kord-trackinfo.json"),
      JSON.stringify({
        "01.flac": { title: "One", trackNumber: 1, discNumber: 1 },
        "02.flac": { title: "Two", trackNumber: 2 },
        "gone.flac": { title: "Gone" },
      }),
    )

    const r = await pruneAlbumLibraryMetadataInAlbumDir(albumDir)
    expect(r.orphanTrackKeysRemoved).toEqual(["gone.flac"])
    expect(r.expectedTracksCleared).toBe(true)
    expect(r.trackOrderingFieldsCleared).toBe(2)
    expect(r.written).toBe(true)

    const album = JSON.parse(
      await fs.readFile(path.join(albumDir, "kord-albuminfo.json"), "utf8"),
    )
    expect(album.expectedTracks).toBeUndefined()
    expect(album.expectedTrackCount).toBeUndefined()

    const tracks = JSON.parse(
      await fs.readFile(path.join(albumDir, "kord-trackinfo.json"), "utf8"),
    )
    expect(tracks["gone.flac"]).toBeUndefined()
    expect(tracks["01.flac"].trackNumber).toBeUndefined()
    expect(tracks["02.flac"].trackNumber).toBeUndefined()
  })
})
