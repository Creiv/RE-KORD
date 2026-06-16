import { describe, expect, it } from "vitest"
import {
  audioMimeForFilePath,
  mediaFileEtag,
  AUDIO_MIME_BY_EXT,
  parseByteRange,
  shouldServeInitialRangeOnly,
  isLosslessMediaPath,
} from "./mediaStream.mjs"
import { needsCastTranscode, CAST_TRANSCODE_EXTS } from "./transcode.mjs"

describe("mediaStream", () => {
  it("AUDIO_MIME_BY_EXT copre le estensioni principali", () => {
    expect(AUDIO_MIME_BY_EXT[".flac"]).toBe("audio/flac")
    expect(AUDIO_MIME_BY_EXT[".mp3"]).toBe("audio/mpeg")
    expect(AUDIO_MIME_BY_EXT[".ogg"]).toBe("audio/ogg")
  })

  it("audioMimeForFilePath risolve dal path", () => {
    expect(audioMimeForFilePath("/music/a/track.mp3")).toBe("audio/mpeg")
    expect(audioMimeForFilePath("/music/a/track.flac")).toBe("audio/flac")
  })

  it("mediaFileEtag è deterministico", () => {
    const etag = mediaFileEtag({ size: 1024, mtimeMs: 1_700_000_000_000 })
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
  })

  it("isLosslessMediaPath riconosce FLAC/WAV", () => {
    expect(isLosslessMediaPath("/a/track.flac")).toBe(true)
    expect(isLosslessMediaPath("/a/track.mp3")).toBe(false)
  })
})

describe("parseByteRange", () => {
  const size = 10_000

  it("parsa range chiuso", () => {
    expect(parseByteRange("bytes=0-499", size)).toEqual({ start: 0, end: 499 })
  })

  it("parsa range open-ended", () => {
    expect(parseByteRange("bytes=5000-", size)).toEqual({
      start: 5000,
      end: size - 1,
    })
  })

  it("parsa suffix range", () => {
    expect(parseByteRange("bytes=-512", size)).toEqual({
      start: size - 512,
      end: size - 1,
    })
  })

  it("segna range invalidi", () => {
    expect(parseByteRange("bytes=99999-100000", size)).toEqual({ invalid: true })
  })
})

describe("shouldServeInitialRangeOnly", () => {
  const bigFlac = { size: 8_000_000 }

  it("attivo su tunnel Cloudflare senza Range", () => {
    const req = {
      method: "GET",
      headers: { host: "abc.trycloudflare.com" },
    }
    expect(shouldServeInitialRangeOnly(req, "/a/b.flac", bigFlac)).toBe(true)
  })

  it("spento su LAN senza Range", () => {
    const req = { method: "GET", headers: { host: "192.168.0.5:3001" } }
    expect(shouldServeInitialRangeOnly(req, "/a/b.flac", bigFlac)).toBe(false)
  })

  it("spento se il client invia già Range", () => {
    const req = {
      method: "GET",
      headers: { host: "abc.trycloudflare.com", range: "bytes=0-" },
    }
    expect(shouldServeInitialRangeOnly(req, "/a/b.flac", bigFlac)).toBe(false)
  })
})

describe("transcode helpers", () => {
  it("needsCastTranscode per formati cast-problematici", () => {
    expect(needsCastTranscode("a/b.flac")).toBe(true)
    expect(needsCastTranscode("a/b.mp3")).toBe(false)
    expect(CAST_TRANSCODE_EXTS.has("wav")).toBe(true)
  })
})
