import { describe, expect, it } from "vitest"
import { sniffImageExt } from "./customThemeBg.mjs"

function bytes(...values: number[]): Buffer {
  return Buffer.from(values)
}

describe("sniffImageExt", () => {
  it("detects gif from magic bytes", () => {
    expect(sniffImageExt(Buffer.from("GIF89a......", "latin1"))).toBe("gif")
    expect(sniffImageExt(Buffer.from("GIF87a......", "latin1"))).toBe("gif")
  })

  it("detects png, jpg and webp", () => {
    expect(sniffImageExt(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("png")
    expect(sniffImageExt(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("jpg")
    const webp = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      bytes(0, 0, 0, 0),
      Buffer.from("WEBP", "latin1"),
    ])
    expect(sniffImageExt(webp)).toBe("webp")
  })

  it("returns null for unknown or short buffers", () => {
    expect(sniffImageExt(Buffer.from("%PDF-1.7....", "latin1"))).toBeNull()
    expect(sniffImageExt(bytes(1, 2))).toBeNull()
    expect(sniffImageExt(null as unknown as Buffer)).toBeNull()
  })
})
