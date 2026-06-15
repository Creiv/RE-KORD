import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaSessionArtwork,
  buildMediaSessionQueueEntries,
  MEDIA_SESSION_ARTWORK_SIZES,
  resolveMediaSessionPauseAction,
  setMediaSessionMetadata,
} from "./mediaSession";
import type { EnrichedTrack } from "../types";

describe("mediaSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("buildMediaSessionArtwork exposes standard widget sizes", () => {
    const art = buildMediaSessionArtwork("https://example.com/cover.jpg");
    expect(art).toHaveLength(MEDIA_SESSION_ARTWORK_SIZES.length);
    expect(art.map((a) => a.sizes)).toEqual([...MEDIA_SESSION_ARTWORK_SIZES]);
    expect(art.every((a) => a.src === "https://example.com/cover.jpg")).toBe(
      true,
    );
  });

  it("resolveMediaSessionPauseAction mutes in automotive while playing", () => {
    expect(
      resolveMediaSessionPauseAction({
        isAutomotive: true,
        isPlaying: true,
        isMuted: false,
      }),
    ).toBe("mute");
  });

  it("resolveMediaSessionPauseAction pauses on phone lock screen", () => {
    expect(
      resolveMediaSessionPauseAction({
        isAutomotive: false,
        isPlaying: true,
        isMuted: false,
      }),
    ).toBe("pause");
  });

  it("setMediaSessionMetadata skips redundant updates for same track", () => {
    const track = {
      id: "t1",
      relPath: "a/b.mp3",
      title: "One",
      artist: "Artist",
      album: "Album",
      updatedAt: 1,
    } as EnrichedTrack;
    const metadataCtor = vi.fn(function MediaMetadata() {
      /* */
    });
    const ms = { metadata: null as MediaMetadata | null };
    vi.stubGlobal("navigator", { mediaSession: ms });
    vi.stubGlobal("MediaMetadata", metadataCtor);
    setMediaSessionMetadata(track);
    setMediaSessionMetadata(track);
    expect(metadataCtor).toHaveBeenCalledTimes(1);
  });

  it("resolveMediaSessionPauseAction pauses in automotive after mute", () => {
    expect(
      resolveMediaSessionPauseAction({
        isAutomotive: true,
        isPlaying: true,
        isMuted: true,
      }),
    ).toBe("pause");
  });

  it("buildMediaSessionQueueEntries espone URI assoluti e indici globali", () => {
    const tracks = [0, 1, 2, 3, 4].map((n) => ({
      id: `t${n}`,
      relPath: `a/${n}.mp3`,
      title: `Track ${n}`,
      artist: "Artist",
      album: "Album",
    })) as import("../types").EnrichedTrack[];
    const { entries, activeIndex } = buildMediaSessionQueueEntries(
      tracks,
      3,
      "http://192.168.0.5:3001",
    );
    expect(activeIndex).toBe(3);
    expect(entries[3]?.queueId).toBe(3);
    expect(entries[3]?.mediaUri).toBe(
      "http://192.168.0.5:3001/media/a/3.mp3",
    );
  });
});
