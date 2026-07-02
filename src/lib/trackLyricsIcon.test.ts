import { describe, expect, it } from "vitest"
import { trackLyricsIconKind } from "./trackLyricsIcon"

describe("trackLyricsIconKind", () => {
  it("nasconde l'icona se mai cercato", () => {
    expect(trackLyricsIconKind({} as never)).toBe("hidden")
  })

  it("mostra spenta dopo auto LRC senza risultato", () => {
    expect(trackLyricsIconKind({ lyricsAutoChecked: true } as never)).toBe("off")
  })

  it("distingue plain e LRC", () => {
    expect(trackLyricsIconKind({ lyrics: "solo testo" } as never)).toBe("plain")
    expect(
      trackLyricsIconKind({ lyrics: "[00:01.00]Ciao" } as never),
    ).toBe("lrc")
  })
})
