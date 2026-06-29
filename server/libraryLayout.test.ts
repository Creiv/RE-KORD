// @vitest-environment node
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import { probeLibraryStructure, DEFAULT_LAYOUT_CONFIG } from "./libraryLayout.mjs"

describe("libraryLayout probe", () => {
  it("detects artist/album layout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-probe-"))
    await fs.mkdir(path.join(root, "Artist", "Album"), { recursive: true })
    await fs.writeFile(path.join(root, "Artist", "Album", "01.mp3"), "")

    const report = await probeLibraryStructure(root)
    expect(report.stats.estimatedTracks).toBeGreaterThanOrEqual(1)
    expect(report.candidates.length).toBeGreaterThan(0)
    expect(report.suggestedLayout.fallbacks).toEqual(DEFAULT_LAYOUT_CONFIG.fallbacks)
  })

  it("flags flat root audio", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rekord-probe-flat-"))
    await fs.writeFile(path.join(root, "song.mp3"), "")

    const report = await probeLibraryStructure(root)
    expect(report.stats.audioAtRoot).toBe(1)
    expect(report.candidates.some((c) => c.layout === "flat")).toBe(true)
  })
})
