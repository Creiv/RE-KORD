import { describe, expect, it } from "vitest"
import {
  audioMimeForFilePath,
  mediaFileEtag,
  AUDIO_MIME_BY_EXT,
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
})

describe("transcode helpers", () => {
  it("needsCastTranscode per formati cast-problematici", () => {
    expect(needsCastTranscode("a/b.flac")).toBe(true)
    expect(needsCastTranscode("a/b.mp3")).toBe(false)
    expect(CAST_TRANSCODE_EXTS.has("wav")).toBe(true)
  })
})
