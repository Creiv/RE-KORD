import { describe, expect, it } from "vitest";
import { parseLrcLyrics, resolveKaraokeLines } from "./karaokeLyrics";

describe("karaokeLyrics", () => {
  it("parseLrcLyrics estrae timestamp e testo", () => {
    const lines = parseLrcLyrics("[00:12.50]Ciao mondo\n[01:02]Seconda riga");
    expect(lines).toEqual([
      { atSec: 12.5, text: "Ciao mondo" },
      { atSec: 62, text: "Seconda riga" },
    ]);
  });

  it("resolveKaraokeLines usa LRC quando presente", () => {
    const raw = "[00:10]Prima\n[00:20]Seconda\n[00:30]Terza";
    expect(resolveKaraokeLines(raw, 21, 60, "Titolo")).toEqual({
      current: "Seconda",
      previous: "Prima",
      next: "Terza",
    });
  });
});
