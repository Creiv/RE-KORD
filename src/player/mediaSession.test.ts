import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaBridge,
  createEmptyMediaBridge,
  resolvePlayerMediaSessionPauseAction,
  syncPlayerMediaSession,
} from "./mediaSession";
import type { EnrichedTrack } from "../types";

function track(relPath: string): EnrichedTrack {
  return {
    id: relPath,
    relPath,
    title: "Title",
    artist: "Artist",
    album: "Album",
    updatedAt: 1,
  };
}

describe("player mediaSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("createEmptyMediaBridge exposes all action slots", () => {
    const bridge = createEmptyMediaBridge();
    expect(typeof bridge.play).toBe("function");
    expect(typeof bridge.cycleRepeat).toBe("function");
    bridge.playQueueIndex(0);
    bridge.seek(1);
    bridge.seekBy(1);
  });

  it("resolvePlayerMediaSessionPauseAction pauses on phone", () => {
    expect(resolvePlayerMediaSessionPauseAction(true, false)).toBe("pause");
  });

  it("syncPlayerMediaSession clears state when no track", () => {
    const metadataCtor = vi.fn(function MediaMetadata() {
      /* */
    });
    const ms = {
      metadata: null as MediaMetadata | null,
      playbackState: "playing" as MediaSessionPlaybackState,
      setActionHandler: vi.fn(),
    };
    vi.stubGlobal("navigator", { mediaSession: ms });
    vi.stubGlobal("MediaMetadata", metadataCtor);

    const audibleRef = { current: track("a.mp3") as EnrichedTrack | null };
    syncPlayerMediaSession({
      currentRef: { current: null },
      audioRef: { current: null },
      queueRef: { current: [] },
      indexRef: { current: 0 },
      repeatRef: { current: "all" },
      queueRemainderRef: { current: null },
      isPlayingRef: { current: false },
      trackLoadingRef: { current: false },
      pendingTrackTransitionRef: { current: false },
      crossfadeBusyRef: { current: false },
      mediaSessionAudibleTrackRef: audibleRef,
      appConfigRef: { current: { lanAccessUrl: null, remotePublicUrl: null } },
      transcodeAvailableRef: { current: true },
      duration: 0,
    });

    expect(audibleRef.current).toBeNull();
    expect(ms.playbackState).toBe("none");
  });

  it("buildMediaBridge wires toggleShuffle", () => {
    const shuffleRef = { current: false };
    let shuffled = false;
    const bridge = buildMediaBridge({
      playForMediaSession: () => {
        /* */
      },
      pauseForMediaSession: () => {
        /* */
      },
      applyMediaMute: () => {
        /* */
      },
      keepPlayingRef: { current: false },
      audioRef: { current: null },
      play: () => {
        /* */
      },
      next: () => {
        /* */
      },
      prev: () => {
        /* */
      },
      playQueueIndex: () => {
        /* */
      },
      seek: () => {
        /* */
      },
      shuffleRef,
      setShuffle: (v) => {
        shuffled = v;
      },
      setRepeat: () => "all",
      currentRef: { current: null },
      toggleFavorite: () => {
        /* */
      },
      toggleShuffleExcludedTrack: () => {
        /* */
      },
      shuffleExcludedAlbumIds: [],
      isTrackAlbumShuffleExcluded: () => false,
    });
    bridge.toggleShuffle();
    expect(shuffled).toBe(true);
  });
});
