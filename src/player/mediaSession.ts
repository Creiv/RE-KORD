import type { RefObject } from "react";
import {
  mediaSessionHasNext,
  mediaSessionHasPrevious,
} from "../lib/playerQueueAdvance";
import {
  type MediaSessionBridge,
  registerMediaSessionActions,
  resolveMediaSessionPauseAction,
  syncMediaSessionState,
  buildMediaSessionQueueEntries,
} from "../lib/mediaSession";
import { castStreamUrl, resolvePlaybackBaseOrigin } from "../lib/castMedia";
import { isAutomotiveDisplayMode } from "../lib/routing";
import { readPlayerProgressTime } from "../context/playerProgressStore";
import type { EnrichedTrack, RepeatMode } from "../types";
import type { AppConfigSnapshot } from "./types";
import { cycleRepeatMode } from "./queueController";

export function createEmptyMediaBridge(): MediaSessionBridge {
  return {
    play: () => {
      return;
    },
    pause: () => {
      return;
    },
    mute: () => {
      return;
    },
    unmute: () => {
      return;
    },
    next: () => {
      return;
    },
    prev: () => {
      return;
    },
    playQueueIndex: (index: number) => {
      void index;
      return;
    },
    seek: (time: number) => {
      void time;
      return;
    },
    seekBy: (delta: number) => {
      void delta;
      return;
    },
    toggleShuffle: () => {
      return;
    },
    cycleRepeat: () => {
      return;
    },
    toggleFavoriteCurrent: () => {
      return;
    },
    toggleExcludeCurrent: () => {
      return;
    },
  };
}

export type PlayerMediaSessionSyncDeps = {
  currentRef: RefObject<EnrichedTrack | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  queueRef: RefObject<EnrichedTrack[]>;
  indexRef: RefObject<number>;
  repeatRef: RefObject<RepeatMode>;
  queueRemainderRef: RefObject<EnrichedTrack[] | null>;
  isPlayingRef: RefObject<boolean>;
  trackLoadingRef: RefObject<boolean>;
  pendingTrackTransitionRef: RefObject<boolean>;
  crossfadeBusyRef: RefObject<boolean>;
  mediaSessionAudibleTrackRef: RefObject<EnrichedTrack | null>;
  appConfigRef: RefObject<AppConfigSnapshot>;
  transcodeAvailableRef: RefObject<boolean>;
  duration: number;
};

export function syncPlayerMediaSession(deps: PlayerMediaSessionSyncDeps): void {
  const uiTrack = deps.currentRef.current;
  if (!uiTrack) {
    deps.mediaSessionAudibleTrackRef.current = null;
    syncMediaSessionState({ track: null, playbackState: "none" });
    return;
  }
  const audio = deps.audioRef.current;
  const loading = deps.trackLoadingRef.current;
  const transitioning =
    deps.pendingTrackTransitionRef.current ||
    loading ||
    deps.crossfadeBusyRef.current;
  const audible = deps.mediaSessionAudibleTrackRef.current;
  const skipMetadata = transitioning && !!audible;
  const sessionTrack = skipMetadata && audible ? audible : uiTrack;

  const rawDur = audio?.duration;
  const dur =
    Number.isFinite(deps.duration) && deps.duration > 0
      ? deps.duration
      : rawDur && Number.isFinite(rawDur) && rawDur > 0
        ? rawDur
        : 0;
  const pos = audio ? readPlayerProgressTime() : 0;
  const baseOrigin = resolvePlaybackBaseOrigin(deps.appConfigRef.current);
  const q = deps.queueRef.current;
  let qIndex = deps.indexRef.current;
  if (skipMetadata && audible) {
    const audibleIdx = q.findIndex((t) => t.relPath === audible.relPath);
    if (audibleIdx >= 0) qIndex = audibleIdx;
  }
  const castOpts = {
    forCast: true as const,
    transcodeAvailable: deps.transcodeAvailableRef.current,
  };
  const { entries: queueEntries, activeIndex } = buildMediaSessionQueueEntries(
    q,
    qIndex,
    baseOrigin,
    castOpts,
  );
  syncMediaSessionState({
    track: sessionTrack,
    playbackState: deps.isPlayingRef.current ? "playing" : "paused",
    duration: dur > 0 ? dur : undefined,
    position: dur > 0 ? pos : undefined,
    playbackRate: audio?.playbackRate || 1,
    skipPosition: transitioning,
    skipMetadata,
    mediaUri: baseOrigin
      ? castStreamUrl(
          sessionTrack.filePath || sessionTrack.relPath,
          baseOrigin,
          castOpts,
        )
      : undefined,
    mediaId: sessionTrack.relPath,
    queue: queueEntries,
    queueIndex: activeIndex,
    hasPrevious: mediaSessionHasPrevious(qIndex, q.length, deps.repeatRef.current),
    hasNext: mediaSessionHasNext(
      qIndex,
      q.length,
      deps.repeatRef.current,
      !!deps.queueRemainderRef.current?.length,
    ),
  });
  if (!transitioning) {
    deps.mediaSessionAudibleTrackRef.current = uiTrack;
  }
}

export function resolvePlayerMediaSessionPauseAction(
  isPlaying: boolean,
  isMuted: boolean,
): "mute" | "pause" {
  return resolveMediaSessionPauseAction({
    isAutomotive: isAutomotiveDisplayMode(),
    isPlaying,
    isMuted,
  });
}

export type MediaBridgeDeps = {
  playForMediaSession: () => void;
  pauseForMediaSession: () => void;
  applyMediaMute: (muted: boolean) => void;
  keepPlayingRef: RefObject<boolean>;
  audioRef: RefObject<HTMLAudioElement | null>;
  play: () => void;
  next: () => void;
  prev: () => void;
  playQueueIndex: (index: number) => void;
  seek: (t: number) => void;
  shuffleRef: RefObject<boolean>;
  setShuffle: (v: boolean) => void;
  setRepeat: (fn: (r: RepeatMode) => RepeatMode) => void;
  currentRef: RefObject<EnrichedTrack | null>;
  toggleFavorite: (relPath: string) => void;
  toggleShuffleExcludedTrack: (relPath: string) => void;
  shuffleExcludedAlbumIds: readonly string[];
  isTrackAlbumShuffleExcluded: (
    track: EnrichedTrack,
    excludedAlbumIds: Set<string>,
  ) => boolean;
};

export function buildMediaBridge(deps: MediaBridgeDeps): MediaSessionBridge {
  return {
    play: () => {
      void deps.playForMediaSession();
    },
    pause: deps.pauseForMediaSession,
    mute: () => {
      deps.applyMediaMute(true);
    },
    unmute: () => {
      deps.applyMediaMute(false);
      if (deps.keepPlayingRef.current && deps.audioRef.current?.paused) {
        void deps.play();
      }
    },
    next: deps.next,
    prev: deps.prev,
    playQueueIndex: deps.playQueueIndex,
    seek: (t) => {
      deps.seek(t);
    },
    seekBy: (d) => {
      const a = deps.audioRef.current;
      if (!a) return;
      const nextT = a.currentTime + d;
      deps.seek(Math.max(0, nextT));
    },
    toggleShuffle: () => {
      deps.setShuffle(!deps.shuffleRef.current);
    },
    cycleRepeat: () => {
      deps.setRepeat((r) => cycleRepeatMode(r));
    },
    toggleFavoriteCurrent: () => {
      const cur = deps.currentRef.current;
      if (!cur) return;
      deps.toggleFavorite(cur.relPath);
    },
    toggleExcludeCurrent: () => {
      const cur = deps.currentRef.current;
      if (!cur) return;
      const exAlbums = new Set(deps.shuffleExcludedAlbumIds);
      if (deps.isTrackAlbumShuffleExcluded(cur, exAlbums)) return;
      deps.toggleShuffleExcludedTrack(cur.relPath);
    },
  };
}

export { registerMediaSessionActions };
