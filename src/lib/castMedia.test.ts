import { describe, expect, it } from "vitest"
import {
  buildCastTrackPayload,
  castMimeTypeForRelPath,
  castStreamUrl,
  isLoopbackHostname,
  resolveCastMediaBaseUrl,
} from "./castMedia"
import type { EnrichedTrack } from "../types"

const track = {
  id: "t1",
  relPath: "Artist/Album/song.mp3",
  title: "Song",
  artist: "Artist",
  album: "Album",
} as EnrichedTrack

describe("castMedia", () => {
  it("isLoopbackHostname riconosce localhost e loopback IPv6", () => {
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("192.168.1.4")).toBe(false)
  })

  it("resolveCastMediaBaseUrl preferisce origin non loopback", () => {
    expect(
      resolveCastMediaBaseUrl({
        pageOrigin: "http://192.168.0.10:3001",
      }),
    ).toBe("http://192.168.0.10:3001")
  })

  it("resolveCastMediaBaseUrl usa lanAccessUrl su localhost", () => {
    expect(
      resolveCastMediaBaseUrl({
        pageOrigin: "http://127.0.0.1:3001",
        lanAccessUrl: "http://192.168.0.10:3001",
      }),
    ).toBe("http://192.168.0.10:3001")
  })

  it("resolveCastMediaBaseUrl torna null senza alternative su loopback", () => {
    expect(
      resolveCastMediaBaseUrl({
        pageOrigin: "http://localhost:3001",
      }),
    ).toBeNull()
  })

  it("castStreamUrl costruisce URL assoluto per il receiver Cast", () => {
    const url = castStreamUrl("a/b.mp3", "http://192.168.0.10:3001")
    expect(url).toBe("http://192.168.0.10:3001/media/a/b.mp3")
  })

  it("castMimeTypeForRelPath mappa le estensioni comuni", () => {
    expect(castMimeTypeForRelPath("x.flac")).toBe("audio/flac")
    expect(castMimeTypeForRelPath("x.m4a")).toBe("audio/mp4")
  })

  it("castStreamUrl usa transcode per FLAC in forCast", () => {
    const url = castStreamUrl("a/album/track.flac", "http://192.168.0.10:3001", {
      forCast: true,
    })
    expect(url).toContain("/media/transcode/a/album/track.flac")
    expect(url).toContain("format=mp3")
  })

  it("buildCastTrackPayload include stream e copertina", () => {
    const payload = buildCastTrackPayload(track, "http://192.168.0.10:3001", 12)
    expect(payload.streamUrl).toContain("/media/Artist/Album/song.mp3")
    expect(payload.coverUrl).toContain("/api/cover?")
    expect(payload.positionSec).toBe(12)
  })
})
