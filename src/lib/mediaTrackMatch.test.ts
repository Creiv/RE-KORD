import { describe, expect, it } from "vitest";
import { audioElementMatchesTrack } from "./mediaTrackMatch";

describe("audioElementMatchesTrack", () => {
  it("matches when pathname equals mediaUrl for relPath", () => {
    const audio = document.createElement("audio");
    audio.src = new URL("/media/foo/bar.mp3", window.location.origin).href;
    expect(audioElementMatchesTrack(audio, { relPath: "foo/bar.mp3" })).toBe(
      true,
    );
  });

  it("matches filePath when it differs from relPath", () => {
    const audio = document.createElement("audio");
    audio.src = new URL("/media/Artist/a.mp3", window.location.origin).href;
    expect(
      audioElementMatchesTrack(audio, {
        relPath: "Artist/Tracks/a.mp3",
        filePath: "Artist/a.mp3",
      }),
    ).toBe(true);
    expect(
      audioElementMatchesTrack(audio, { relPath: "Artist/Tracks/a.mp3" }),
    ).toBe(false);
  });

  it("rejects stale deck with different track", () => {
    const audio = document.createElement("audio");
    audio.src = new URL("/media/old.mp3", window.location.origin).href;
    expect(audioElementMatchesTrack(audio, { relPath: "new.mp3" })).toBe(false);
  });

  it("returns false when src is empty", () => {
    const audio = document.createElement("audio");
    expect(audioElementMatchesTrack(audio, { relPath: "x.mp3" })).toBe(false);
  });
});
