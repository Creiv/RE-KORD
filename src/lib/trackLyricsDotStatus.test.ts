import { describe, expect, it } from "vitest";
import { resolveTrackLyricsDotStatus } from "./trackLyricsDotStatus";

describe("resolveTrackLyricsDotStatus", () => {
  it("mostra busy durante il fetch", () => {
    expect(resolveTrackLyricsDotStatus({ fetchBusy: true })).toBe("busy");
  });

  it("distingue LRC, plain, missing e idle", () => {
    expect(
      resolveTrackLyricsDotStatus({
        meta: { lyrics: "[00:01.00]Ciao" },
      }),
    ).toBe("okLrc");
    expect(
      resolveTrackLyricsDotStatus({
        meta: { lyrics: "solo testo" },
      }),
    ).toBe("okPlain");
    expect(
      resolveTrackLyricsDotStatus({
        meta: { lyricsAutoChecked: true },
      }),
    ).toBe("missing");
    expect(resolveTrackLyricsDotStatus({})).toBe("idle");
  });

  it("preferisce il testo locale rispetto ai metadati", () => {
    expect(
      resolveTrackLyricsDotStatus({
        meta: { lyrics: "vecchio" },
        lyricsText: "[00:02.00]Nuovo",
      }),
    ).toBe("okLrc");
  });

  it("usa lo stato effimero dell'ultima esecuzione Auto LRC", () => {
    expect(
      resolveTrackLyricsDotStatus({
        ephemeralAutoStatus: "error",
      }),
    ).toBe("error");
    expect(
      resolveTrackLyricsDotStatus({
        ephemeralAutoStatus: "missing",
      }),
    ).toBe("missing");
  });
});
