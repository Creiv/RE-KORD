/* eslint-disable react-refresh/only-export-components -- hook + provider */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { resolveTrackFromLibrary, trackPlaybackKey } from "../lib/libraryNav";
import { resolveNextIndex, resolvePrevIndex } from "../lib/playerQueueAdvance";
import { mediaUrlForTrack, fetchConfig } from "../lib/api";
import { enrichTrack } from "../lib/enrichTrack";
import { enrichedTracksNeedPlayerResync } from "../lib/libraryIndex";
import { isTrackAlbumShuffleExcluded } from "../lib/randomExclusions";
import { syncWebCastNow } from "../lib/castPlayback";
import { prefetchQueueCovers } from "../lib/coverPrefetch";
import { isAutomotiveDisplayMode } from "../lib/routing";
import {
  QUEUE_HISTORY_KEEP,
  QUEUE_REFILL_BATCH,
  QUEUE_REFILL_THRESHOLD,
} from "../lib/smartShuffle";
import {
  computeQueueInsertIndex,
  insertTracksInQueue,
} from "../lib/queueInsert";
import {
  resetPlayerProgressTime,
  setPlayerProgressTime,
} from "./playerProgressStore";
import { useUserState } from "./UserStateContext";
import type { EnrichedTrack, LibAlbum, LibraryIndex } from "../types";
import {
  audioReadyEnough,
  createCrossfadeManager,
  deckAudio,
  setupDualDeckAudioGraph,
  waitForAudioReady,
} from "../player/audioEngine";
import { applyMediaMute, setupCastPlayback } from "../player/castController";
import {
  buildMediaBridge,
  createEmptyMediaBridge,
  registerMediaSessionActions,
  resolvePlayerMediaSessionPauseAction,
  syncPlayerMediaSession,
} from "../player/mediaSession";
import {
  capQueueAroundFocus,
  computeIndexAfterMove,
  computeIndexAfterRemove,
  planPlayTrackQueue,
  reorder,
  restoreQueueFromShufflePaths,
  shuffleTailFromCurrent,
} from "../player/queueController";
import { createSleepTimerController } from "../player/sleepTimer";
import {
  FIXED_VOLUME,
  MAX_QUEUE_LENGTH,
  type DeckIx,
  type PlayerContextValue,
  type TrackRowPlayerStore,
} from "../player/types";

const PlayerContext = createContext<PlayerContextValue | null>(null);
const TrackRowPlayerContext = createContext<TrackRowPlayerStore | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const user = useUserState();
  const userReady = user.ready;
  const restoreSession = user.state.settings.restoreSession;
  const persistedQueue = user.state.queue;
  const pushRecent = user.pushRecent;
  const incrementTrackPlayCount = user.incrementTrackPlayCount;
  const enqueueQueuePatch = user.enqueueQueuePatch;
  const flushUserStateNow = user.flushUserStateNow;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioDeck0Ref = useRef<HTMLAudioElement | null>(null);
  const audioDeck1Ref = useRef<HTMLAudioElement | null>(null);
  const gain0Ref = useRef<GainNode | null>(null);
  const gain1Ref = useRef<GainNode | null>(null);
  const [activeDeckIx, setActiveDeckIx] = useState<DeckIx>(0);
  const activeDeckRef = useRef<DeckIx>(0);
  const crossfadeBusyRef = useRef(false);
  const crossfadeTimerRef = useRef(0);
  const crossfadeGenRef = useRef(0);
  const crossfadeOutIxRef = useRef<DeckIx | null>(null);
  const crossfadeInIxRef = useRef<DeckIx | null>(null);
  const crossfadeNextIdxRef = useRef<number | null>(null);
  const skipNextCurrentLoadRef = useRef(false);
  const trackLoadGenRef = useRef(0);
  const prefetchedRelPathRef = useRef<string | null>(null);
  const audioCrossfadeSecRef = useRef(user.state.settings.audioCrossfadeSec);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const getAnalyser = useCallback(() => analyserRef.current, []);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const keepPlayingRef = useRef(true);
  const isPlayingRef = useRef(false);
  const mediaMutedRef = useRef(false);
  const appInitiatedPauseRef = useRef(false);
  const syncMediaSessionNowRef = useRef<() => void>(() => {
    /* bound in effect */
  });
  const trackLoadingRef = useRef(false);
  const mediaSessionAudibleTrackRef = useRef<EnrichedTrack | null>(null);
  const pendingTrackTransitionRef = useRef(false);
  const transcodeAvailableRef = useRef(true);
  const appConfigRef = useRef({
    lanAccessUrl: null as string | null,
    remotePublicUrl: null as string | null,
  });
  const outputGainRef = useRef<GainNode | null>(null);
  const sleepTimerTimeoutRef = useRef(0);
  const sleepFadeIntervalRef = useRef(0);
  const [sleepTimerEndsAt, setSleepTimerEndsAt] = useState<number | null>(null);
  const restoredRef = useRef(false);
  const repeatRef = useRef<"off" | "all" | "one">("all");
  const lastTrackBoundaryAdvanceAtRef = useRef(0);
  const [current, setCurrent] = useState<EnrichedTrack | null>(null);
  const currentRelPath = current?.relPath;
  const [queue, setQueue] = useState<EnrichedTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume] = useState(FIXED_VOLUME);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("all");
  const [shuffle, setShuffleState] = useState(false);
  const queueRef = useRef(queue);
  const indexRef = useRef(currentIndex);
  const shuffleRef = useRef(false);
  const preShuffleRelPathsRef = useRef<string[] | null>(null);
  const queueRemainderRef = useRef<EnrichedTrack[] | null>(null);
  const manualQueuedRef = useRef<Set<string>>(new Set());
  const mediaBridgeRef = useRef(createEmptyMediaBridge());
  const currentRef = useRef<EnrichedTrack | null>(null);
  const lastMediaPosAtRef = useRef(0);
  const lastMediaRelPathRef = useRef<string | null>(null);
  const lastMediaSessionSyncAtRef = useRef(0);
  const halfListenCountedRef = useRef(false);
  const halfListenTrackRef = useRef<string | null>(null);

  const crossfadeRefs = useMemo(
    () => ({
      audioDeck0Ref,
      audioDeck1Ref,
      gain0Ref,
      gain1Ref,
      audioCtxRef,
      activeDeckRef,
      queueRef,
      currentRef,
      crossfadeBusyRef,
      crossfadeOutIxRef,
      crossfadeInIxRef,
      crossfadeNextIdxRef,
      crossfadeGenRef,
      crossfadeTimerRef,
      prefetchedRelPathRef,
      skipNextCurrentLoadRef,
      audioCrossfadeSecRef,
      repeatRef,
      indexRef,
      keepPlayingRef,
      mediaSessionAudibleTrackRef,
      pendingTrackTransitionRef,
    }),
    [],
  );

  const spliceRemainderBatch = useCallback((): EnrichedTrack[] => {
    const remainder = queueRemainderRef.current;
    if (!remainder?.length) return [];
    const q = queueRef.current;
    const space = MAX_QUEUE_LENGTH - q.length;
    if (space <= 0) return [];
    const batch = remainder.splice(
      0,
      Math.min(QUEUE_REFILL_BATCH, Math.max(0, space)),
    );
    if (!remainder.length) queueRemainderRef.current = null;
    if (batch.length && shuffleRef.current && preShuffleRelPathsRef.current) {
      preShuffleRelPathsRef.current = [
        ...preShuffleRelPathsRef.current,
        ...batch.map((t) => t.relPath),
      ];
    }
    if (batch.length) {
      const nextQ = [...q, ...batch];
      queueRef.current = nextQ;
      setQueue(nextQ);
    }
    return batch;
  }, []);

  const resolveNextPlaybackIndex = useCallback(
    (baseIndex: number): number | null => {
      const cur = baseIndex;
      let len = queueRef.current.length;
      const hasRemainder = !!queueRemainderRef.current?.length;
      let nextIdx = resolveNextIndex(len, cur, repeatRef.current, hasRemainder);
      if (nextIdx == null) return null;
      if (nextIdx >= len && hasRemainder) {
        spliceRemainderBatch();
        len = queueRef.current.length;
        if (nextIdx >= len) {
          nextIdx = resolveNextIndex(
            len,
            cur,
            repeatRef.current,
            !!queueRemainderRef.current?.length,
          );
        }
      }
      return nextIdx;
    },
    [spliceRemainderBatch],
  );

  const crossfadeCallbacksRef = useRef({
    setActiveDeckIx,
    setCurrentIndex,
    setCurrent,
    setDuration,
    setCurrentTime,
    setPlayerProgressTime,
    setIsPlaying,
    pushRecent,
    resolveNextPlaybackIndex,
  });
  crossfadeCallbacksRef.current = {
    setActiveDeckIx,
    setCurrentIndex,
    setCurrent,
    setDuration,
    setCurrentTime,
    setPlayerProgressTime,
    setIsPlaying,
    pushRecent,
    resolveNextPlaybackIndex,
  };

  const crossfadeManager = useMemo(
    () =>
      createCrossfadeManager(crossfadeRefs, {
        setActiveDeckIx: (ix) =>
          crossfadeCallbacksRef.current.setActiveDeckIx(ix),
        setCurrentIndex: (i) =>
          crossfadeCallbacksRef.current.setCurrentIndex(i),
        setCurrent: (t) => crossfadeCallbacksRef.current.setCurrent(t),
        setDuration: (d) => crossfadeCallbacksRef.current.setDuration(d),
        setCurrentTime: (t) =>
          crossfadeCallbacksRef.current.setCurrentTime(t),
        setPlayerProgressTime: (t, force) =>
          crossfadeCallbacksRef.current.setPlayerProgressTime(t, force),
        setIsPlaying: (v) =>
          crossfadeCallbacksRef.current.setIsPlaying(v),
        pushRecent: (t) => crossfadeCallbacksRef.current.pushRecent(t),
        resolveNextPlaybackIndex: (i) =>
          crossfadeCallbacksRef.current.resolveNextPlaybackIndex(i),
      }),
    [crossfadeRefs],
  );

  const {
    snapGainsToSolo: snapGains,
    finalizeCrossfade,
    abortCrossfade,
    prefetchNextOnInactiveDeck,
    startCrossfade,
  } = crossfadeManager;

  useEffect(() => {
    void fetchConfig()
      .then((cfg) => {
        transcodeAvailableRef.current = cfg.transcodeAvailable !== false;
        appConfigRef.current = {
          lanAccessUrl: cfg.lanAccessUrl ?? null,
          remotePublicUrl: cfg.remoteAccess?.publicUrl ?? null,
        };
        syncMediaSessionNowRef.current();
      })
      .catch(() => {
        /* server config opzionale */
      });
  }, []);

  useEffect(() => {
    queueRef.current = queue;
    indexRef.current = currentIndex;
  }, [queue, currentIndex]);

  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useLayoutEffect(() => {
    if (currentRelPath === undefined) return;
    resetPlayerProgressTime();
    const timer = window.setTimeout(() => setCurrentTime(0), 0);
    return () => window.clearTimeout(timer);
  }, [currentRelPath]);

  useEffect(() => {
    activeDeckRef.current = activeDeckIx;
  }, [activeDeckIx]);

  useLayoutEffect(() => {
    audioRef.current =
      activeDeckIx === 0 ? audioDeck0Ref.current : audioDeck1Ref.current;
  }, [activeDeckIx]);

  useEffect(() => {
    audioCrossfadeSecRef.current = user.state.settings.audioCrossfadeSec;
  }, [user.state.settings.audioCrossfadeSec]);

  const advanceAfterTrackCompleted = useCallback(() => {
    const now = performance.now();
    if (now - lastTrackBoundaryAdvanceAtRef.current < 450) return;
    if (crossfadeBusyRef.current) return;

    const audio = audioRef.current;
    const cur = currentRef.current;
    if (!audio || !cur) return;

    const d = audio.duration;
    const atEnd =
      audio.ended ||
      (Number.isFinite(d) && d > 0 && audio.currentTime >= d - 0.35);
    if (!atEnd) return;

    lastTrackBoundaryAdvanceAtRef.current = now;

    if (repeatRef.current === "one") {
      audio.currentTime = 0;
      void audio.play().catch(() => setIsPlaying(false));
      return;
    }

    const nextIndex = resolveNextPlaybackIndex(indexRef.current);
    if (nextIndex == null) {
      keepPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const nextTr = queueRef.current[nextIndex];
    if (nextTr?.relPath === cur.relPath) {
      audio.currentTime = 0;
      setCurrentTime(0);
      setPlayerProgressTime(0, true);
      keepPlayingRef.current = true;
      void audio.play().catch(() => setIsPlaying(false));
      return;
    }
    setCurrentIndex(nextIndex);
    setCurrent(nextTr || null);
    keepPlayingRef.current = true;
  }, [resolveNextPlaybackIndex]);

  useLayoutEffect(() => {
    const a0 = audioDeck0Ref.current;
    const a1 = audioDeck1Ref.current;
    if (!a0 || !a1 || audioCtxRef.current) return;

    const graph = setupDualDeckAudioGraph(a0, a1);
    if (!graph) return;

    gain0Ref.current = graph.gain0;
    gain1Ref.current = graph.gain1;
    outputGainRef.current = graph.outputGain;
    audioCtxRef.current = graph.ctx;
    analyserRef.current = graph.analyser;

    return () => {
      analyserRef.current = null;
      gain0Ref.current = null;
      gain1Ref.current = null;
      outputGainRef.current = null;
      audioCtxRef.current = null;
      void graph.ctx.close();
    };
  }, []);

  useEffect(() => {
    const a0 = audioDeck0Ref.current;
    const a1 = audioDeck1Ref.current;
    if (a0) a0.volume = volume;
    if (a1) a1.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!userReady || restoredRef.current) return;
    restoredRef.current = true;
    if (restoreSession && persistedQueue.tracks.length > 0) {
      const timer = window.setTimeout(() => {
        const { items, index } = capQueueAroundFocus(
          persistedQueue.tracks,
          persistedQueue.currentIndex,
        );
        setQueue(items);
        setCurrentIndex(index);
        setCurrent(items[index] || items[0] || null);
        keepPlayingRef.current = false;
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [persistedQueue, restoreSession, userReady]);

  useEffect(() => {
    if (!userReady || !restoreSession) return;
    enqueueQueuePatch({ tracks: queue, currentIndex });
  }, [currentIndex, enqueueQueuePatch, queue, restoreSession, userReady]);

  useEffect(() => {
    if (!queue.length) return;
    const remainder = queueRemainderRef.current;
    const ahead = queue.length - 1 - currentIndex;
    const needRefill =
      !!remainder?.length && ahead <= QUEUE_REFILL_THRESHOLD;
    const canTrim =
      !crossfadeBusyRef.current &&
      repeatRef.current !== "all" &&
      currentIndex > QUEUE_HISTORY_KEEP;
    if (!needRefill && !canTrim) return;
    const drop = canTrim ? currentIndex - QUEUE_HISTORY_KEEP : 0;
    let batch: EnrichedTrack[] = [];
    if (needRefill && remainder) {
      const space = MAX_QUEUE_LENGTH - (queue.length - drop);
      batch = remainder.splice(
        0,
        Math.min(QUEUE_REFILL_BATCH, Math.max(0, space)),
      );
      if (!remainder.length) queueRemainderRef.current = null;
    }
    if (!drop && !batch.length) return;
    if (batch.length && shuffleRef.current && preShuffleRelPathsRef.current) {
      preShuffleRelPathsRef.current = [
        ...preShuffleRelPathsRef.current,
        ...batch.map((t) => t.relPath),
      ];
    }
    setQueue((p) => [...p.slice(drop), ...batch]);
    if (drop > 0) setCurrentIndex((i) => Math.max(0, i - drop));
  }, [queue, currentIndex]);

  useEffect(() => {
    if (current?.relPath) manualQueuedRef.current.delete(current.relPath);
  }, [current?.relPath]);

  useEffect(() => {
    if (!userReady || !restoreSession) return;
    const onPageHide = () => {
      enqueueQueuePatch({ tracks: queue, currentIndex });
      flushUserStateNow();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [
    currentIndex,
    enqueueQueuePatch,
    flushUserStateNow,
    queue,
    restoreSession,
    userReady,
  ]);

  useEffect(() => {
    if (!current) {
      trackLoadGenRef.current += 1;
      prefetchedRelPathRef.current = null;
      void abortCrossfade();
      activeDeckRef.current = 0;
      window.setTimeout(() => setActiveDeckIx(0), 0);
      snapGains(0);
      const a0 = audioDeck0Ref.current;
      const a1 = audioDeck1Ref.current;
      a0?.pause();
      a1?.pause();
      a0?.removeAttribute("src");
      a1?.removeAttribute("src");
      void a0?.load();
      void a1?.load();
      return;
    }
    if (skipNextCurrentLoadRef.current) {
      skipNextCurrentLoadRef.current = false;
      const ready = deckAudio(
        activeDeckRef.current,
        audioDeck0Ref.current,
        audioDeck1Ref.current,
      );
      const expectedKey = trackPlaybackKey(current);
      const deckMatchesCurrent =
        ready &&
        prefetchedRelPathRef.current === expectedKey &&
        audioReadyEnough(ready);
      if (deckMatchesCurrent) {
        if (Number.isFinite(ready.duration) && ready.duration > 0) {
          setDuration(ready.duration);
        }
        const t = ready.currentTime;
        setCurrentTime(t);
        setPlayerProgressTime(t, true);
        return;
      }
    }

    void abortCrossfade();

    const track = current;
    const gen = ++trackLoadGenRef.current;
    const outIx = activeDeckRef.current;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl = deckAudio(outIx, audioDeck0Ref.current, audioDeck1Ref.current);
    const inEl = deckAudio(inIx, audioDeck0Ref.current, audioDeck1Ref.current);
    if (!outEl || !inEl) return;

    const run = async () => {
      pendingTrackTransitionRef.current = true;
      trackLoadingRef.current = true;
      syncMediaSessionNowRef.current();
      try {
        const url = mediaUrlForTrack(track);
        const playbackKey = trackPlaybackKey(track);
        const alreadyBuffered =
          prefetchedRelPathRef.current === playbackKey &&
          audioReadyEnough(inEl);
        if (!alreadyBuffered) {
          prefetchedRelPathRef.current = playbackKey;
          inEl.src = url;
          inEl.load();
          try {
            await waitForAudioReady(inEl);
          } catch {
            if (gen !== trackLoadGenRef.current) return;
            outEl.pause();
            setIsPlaying(false);
            syncMediaSessionNowRef.current();
            return;
          }
        }
        if (gen !== trackLoadGenRef.current) return;

        snapGains(inIx);
        activeDeckRef.current = inIx;
        setActiveDeckIx(inIx);

        if (Number.isFinite(inEl.duration) && inEl.duration > 0) {
          setDuration(inEl.duration);
        }
        const deckT = inEl.currentTime;
        setCurrentTime(deckT);
        setPlayerProgressTime(deckT, true);
        if (keepPlayingRef.current) {
          const ctx = audioCtxRef.current;
          if (ctx && ctx.state === "suspended") await ctx.resume();
          try {
            await inEl.play();
            if (gen !== trackLoadGenRef.current) return;
            outEl.pause();
            outEl.removeAttribute("src");
            void outEl.load();
            setIsPlaying(true);
            mediaSessionAudibleTrackRef.current = track;
            pendingTrackTransitionRef.current = false;
            pushRecent(track);
            syncMediaSessionNowRef.current();
          } catch {
            if (gen !== trackLoadGenRef.current) return;
            setIsPlaying(false);
            syncMediaSessionNowRef.current();
          }
        } else {
          outEl.pause();
          outEl.removeAttribute("src");
          void outEl.load();
        }
      } finally {
        if (gen === trackLoadGenRef.current) {
          trackLoadingRef.current = false;
          pendingTrackTransitionRef.current = false;
          syncMediaSessionNowRef.current();
        }
      }
    };
    void run();

    return () => {
      trackLoadGenRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abortCrossfade, currentRelPath, pushRecent, snapGains]);

  useEffect(() => {
    halfListenTrackRef.current = currentRelPath ?? null;
    halfListenCountedRef.current = false;
  }, [currentRelPath]);

  useEffect(() => {
    const a0 = audioDeck0Ref.current;
    const a1 = audioDeck1Ref.current;
    if (!a0 || !a1) return;

    const ixFor = (el: HTMLAudioElement): DeckIx => (el === a0 ? 0 : 1);

    const bind = (audio: HTMLAudioElement) => {
      const onTime = () => {
        if (ixFor(audio) !== activeDeckRef.current) return;
        setPlayerProgressTime(audio.currentTime);
        if (
          audio.duration &&
          !Number.isNaN(audio.duration) &&
          audio.duration > 0
        ) {
          setDuration(audio.duration);
        }
        prefetchNextOnInactiveDeck();
        const relPath = currentRef.current?.relPath;
        if (!relPath) return;
        if (halfListenTrackRef.current !== relPath) {
          halfListenTrackRef.current = relPath;
          halfListenCountedRef.current = false;
        }
        const safeDuration =
          audio.duration && !Number.isNaN(audio.duration) ? audio.duration : 0;
        if (!safeDuration) return;
        if (halfListenCountedRef.current && audio.currentTime < safeDuration * 0.1) {
          halfListenCountedRef.current = false;
        }
        if (!halfListenCountedRef.current && audio.currentTime >= safeDuration * 0.5) {
          halfListenCountedRef.current = true;
          incrementTrackPlayCount(relPath);
        }

        if (audioCrossfadeSecRef.current > 0 && repeatRef.current !== "one") {
          void startCrossfade();
        }

        const now = Date.now();
        if (now - lastMediaSessionSyncAtRef.current >= 900) {
          lastMediaSessionSyncAtRef.current = now;
          syncMediaSessionNowRef.current();
        }
      };
      const onMeta = () => {
        if (ixFor(audio) !== activeDeckRef.current) return;
        if (
          audio.duration &&
          !Number.isNaN(audio.duration) &&
          audio.duration > 0
        ) {
          setDuration(audio.duration);
        }
      };
      const onEnd = () => {
        if (ixFor(audio) !== activeDeckRef.current) return;
        if (crossfadeBusyRef.current) {
          finalizeCrossfade();
          return;
        }
        advanceAfterTrackCompleted();
      };
      const onPlay = () => {
        if (crossfadeBusyRef.current) {
          const inIx = crossfadeInIxRef.current;
          if (inIx != null && ixFor(audio) === inIx) {
            setIsPlaying(true);
            return;
          }
        }
        if (ixFor(audio) !== activeDeckRef.current) return;
        setIsPlaying(true);
        const cur = currentRef.current;
        if (cur) mediaSessionAudibleTrackRef.current = cur;
      };
      const onExternalPause = () => {
        if (appInitiatedPauseRef.current) return;
        if (crossfadeBusyRef.current) return;
        if (ixFor(audio) !== activeDeckRef.current) return;
        if (audio.ended) return;
        const d = audio.duration;
        const nearEnd =
          Number.isFinite(d) && d > 0 && audio.currentTime >= d - 0.5;
        if (nearEnd) {
          setIsPlaying(false);
          syncMediaSessionNowRef.current();
          return;
        }
        if (!keepPlayingRef.current || !currentRef.current) return;
        if (isAutomotiveDisplayMode()) {
          audio.muted = true;
          mediaMutedRef.current = true;
          void audio.play().catch(() => {
            /* */
          });
        } else {
          setIsPlaying(false);
        }
        syncMediaSessionNowRef.current();
      };
      const onVolumeChange = () => {
        if (ixFor(audio) !== activeDeckRef.current) return;
        if (!audio.muted && mediaMutedRef.current) {
          mediaMutedRef.current = false;
          syncMediaSessionNowRef.current();
        }
      };
      audio.addEventListener("timeupdate", onTime);
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("ended", onEnd);
      audio.addEventListener("play", onPlay);
      audio.addEventListener("pause", onExternalPause);
      audio.addEventListener("volumechange", onVolumeChange);
      return () => {
        audio.removeEventListener("timeupdate", onTime);
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onExternalPause);
        audio.removeEventListener("volumechange", onVolumeChange);
      };
    };

    const u0 = bind(a0);
    const u1 = bind(a1);
    return () => {
      u0();
      u1();
    };
  }, [
    advanceAfterTrackCompleted,
    finalizeCrossfade,
    incrementTrackPlayCount,
    prefetchNextOnInactiveDeck,
    startCrossfade,
  ]);

  useEffect(() => {
    const recoverAfterForeground = () => {
      if (document.visibilityState !== "visible") return;
      const wctx = audioCtxRef.current;
      if (wctx?.state === "suspended") void wctx.resume();
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.ended) {
        if (crossfadeBusyRef.current) finalizeCrossfade();
        else advanceAfterTrackCompleted();
        return;
      }
      if (keepPlayingRef.current && audio.paused) {
        void audio
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false))
          .finally(() => syncMediaSessionNowRef.current());
      } else {
        syncMediaSessionNowRef.current();
      }
    };
    document.addEventListener("visibilitychange", recoverAfterForeground);
    window.addEventListener("pageshow", recoverAfterForeground);
    return () => {
      document.removeEventListener("visibilitychange", recoverAfterForeground);
      window.removeEventListener("pageshow", recoverAfterForeground);
    };
  }, [advanceAfterTrackCompleted, finalizeCrossfade]);

  useEffect(() => {
    if (currentRelPath === undefined || queue.length === 0) return;
    const HEAD_BYTES = 262_144;
    for (let i = 1; i <= 2; i++) {
      const tr = queue[currentIndex + i];
      if (!tr) continue;
      const url = mediaUrlForTrack(tr);
      void fetch(url, {
        headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
        cache: "force-cache",
      }).catch(() => {
        /* best-effort */
      });
    }
  }, [currentRelPath, currentIndex, queue]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!keepPlayingRef.current) return;
      advanceAfterTrackCompleted();
    }, 900);
    return () => window.clearInterval(id);
  }, [advanceAfterTrackCompleted]);

  const syncMediaSessionNow = useCallback(() => {
    syncPlayerMediaSession({
      currentRef,
      audioRef,
      queueRef,
      indexRef,
      repeatRef,
      queueRemainderRef,
      isPlayingRef,
      trackLoadingRef,
      pendingTrackTransitionRef,
      crossfadeBusyRef,
      mediaSessionAudibleTrackRef,
      appConfigRef,
      transcodeAvailableRef,
      duration,
    });
  }, [duration]);

  useEffect(() => {
    syncMediaSessionNowRef.current = syncMediaSessionNow;
  }, [syncMediaSessionNow]);

  const applyMediaMuteCb = useCallback(
    (muted: boolean) => {
      applyMediaMute(
        muted,
        mediaMutedRef,
        audioDeck0Ref.current,
        audioDeck1Ref.current,
        syncMediaSessionNow,
      );
    },
    [syncMediaSessionNow],
  );

  useEffect(() => {
    return setupCastPlayback({
      currentRef,
      appConfigRef,
      transcodeAvailableRef,
      applyMediaMute: applyMediaMuteCb,
    });
  }, [applyMediaMuteCb]);

  useEffect(() => {
    syncWebCastNow();
    prefetchQueueCovers(queue, currentIndex, 4);
  }, [current?.relPath, currentIndex, queue]);

  const play = useCallback(async () => {
    void abortCrossfade();
    if (mediaMutedRef.current) applyMediaMuteCb(false);
    const ix = activeDeckRef.current;
    const audio = ix === 0 ? audioDeck0Ref.current : audioDeck1Ref.current;
    if (!audio) return;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") await ctx.resume();
    try {
      await audio.play();
      keepPlayingRef.current = true;
      setIsPlaying(true);
      const cur = currentRef.current;
      if (cur) mediaSessionAudibleTrackRef.current = cur;
      if (cur) pushRecent(cur);
      syncMediaSessionNow();
    } catch {
      setIsPlaying(false);
      syncMediaSessionNow();
    }
  }, [abortCrossfade, applyMediaMuteCb, pushRecent, syncMediaSessionNow]);

  const pause = useCallback(() => {
    appInitiatedPauseRef.current = true;
    void abortCrossfade();
    audioDeck0Ref.current?.pause();
    audioDeck1Ref.current?.pause();
    keepPlayingRef.current = false;
    setIsPlaying(false);
    appInitiatedPauseRef.current = false;
    syncMediaSessionNow();
  }, [abortCrossfade, syncMediaSessionNow]);

  const sleepTimerController = useMemo(
    () =>
      createSleepTimerController({
        sleepTimerTimeoutRef,
        sleepFadeIntervalRef,
        outputGainRef,
        setSleepTimerEndsAt,
        pause,
      }),
    [pause],
  );

  const { set: setSleepTimer } = sleepTimerController;

  const pauseForMediaSession = useCallback(() => {
    const action = resolvePlayerMediaSessionPauseAction(
      isPlayingRef.current,
      mediaMutedRef.current,
    );
    if (action === "mute") {
      applyMediaMuteCb(true);
      return;
    }
    pause();
  }, [applyMediaMuteCb, pause]);

  const playForMediaSession = useCallback(() => {
    keepPlayingRef.current = true;
    if (mediaMutedRef.current) applyMediaMuteCb(false);
    const ctx = audioCtxRef.current;
    if (ctx?.state === "suspended") void ctx.resume();
    void play();
  }, [applyMediaMuteCb, play]);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else void play();
  }, [isPlaying, pause, play]);

  const seek = useCallback(
    (time: number) => {
      void abortCrossfade();
      const t = Math.max(0, time);
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = t;
      setCurrentTime(t);
      setPlayerProgressTime(t, true);
      syncMediaSessionNow();
    },
    [abortCrossfade, syncMediaSessionNow],
  );

  const seekRatio = useCallback(
    (ratio: number) => {
      if (!duration) return;
      seek(ratio * duration);
    },
    [duration, seek],
  );

  const playTrack = useCallback(
    (
      track: EnrichedTrack,
      list?: EnrichedTrack[],
      at?: number,
      opts?: { preserveQueueOrder?: boolean; refillRemainder?: EnrichedTrack[] },
    ) => {
      const plan = planPlayTrackQueue(
        track,
        list,
        at,
        shuffle,
        queueRef.current,
        opts,
      );
      if (opts?.refillRemainder !== undefined) {
        queueRemainderRef.current = opts.refillRemainder.length
          ? [...opts.refillRemainder]
          : null;
      } else if (plan.queueReplaced) {
        queueRemainderRef.current = null;
      }
      if (plan.queueReplaced) manualQueuedRef.current.clear();
      if (plan.shouldShuffle && plan.shuffledQueue) {
        preShuffleRelPathsRef.current = plan.nextQueue.map((t) => t.relPath);
        pendingTrackTransitionRef.current = true;
        setQueue(plan.shuffledQueue);
        setCurrentIndex(plan.safeIndex);
        setCurrent(plan.shuffledQueue[plan.safeIndex] || null);
      } else {
        if (
          plan.nextQueue[plan.safeIndex]?.relPath !==
          currentRef.current?.relPath
        ) {
          pendingTrackTransitionRef.current = true;
        }
        setQueue(plan.nextQueue);
        setCurrentIndex(plan.safeIndex);
        setCurrent(plan.nextQueue[plan.safeIndex] || null);
        if (plan.queueReplaced) {
          preShuffleRelPathsRef.current = shuffle
            ? plan.nextQueue.map((t) => t.relPath)
            : null;
        }
      }
      keepPlayingRef.current = true;
    },
    [shuffle],
  );

  const replaceQueueKeepingPlayback = useCallback(
    (
      fullQueue: EnrichedTrack[],
      opts?: { refillRemainder?: EnrichedTrack[] },
    ) => {
      if (!fullQueue.length) return;
      const curIdx = indexRef.current;
      const currentPath = queueRef.current[curIdx]?.relPath;
      if (!currentPath) return;

      let focusIdx = fullQueue.findIndex((t) => t.relPath === currentPath);
      if (focusIdx < 0) focusIdx = Math.min(curIdx, fullQueue.length - 1);

      const { items, index } = capQueueAroundFocus(fullQueue, focusIdx);
      manualQueuedRef.current.clear();
      if (opts?.refillRemainder !== undefined) {
        queueRemainderRef.current = opts.refillRemainder.length
          ? [...opts.refillRemainder]
          : null;
      } else {
        queueRemainderRef.current = null;
      }
      preShuffleRelPathsRef.current = shuffleRef.current
        ? items.map((t) => t.relPath)
        : null;
      setQueue(items);
      setCurrentIndex(index);
    },
    [],
  );

  const playAlbum = useCallback(
    (artist: string, album: LibAlbum) => {
      const tracks = album.tracks.map((t) =>
        enrichTrack(artist, album.name, t, album.meta),
      );
      if (!tracks.length) return;
      playTrack(tracks[0], tracks, 0);
    },
    [playTrack],
  );

  const addToQueue = useCallback(
    (track: EnrichedTrack | EnrichedTrack[]) => {
      const items = Array.isArray(track) ? track : [track];
      const prev = queueRef.current;
      const space = Math.max(0, MAX_QUEUE_LENGTH - prev.length);
      const toAdd = items.slice(0, space);
      if (!toAdd.length) return;
      if (!currentRef.current && toAdd[0]) {
        setCurrent(toAdd[0]);
        keepPlayingRef.current = true;
      }
      const at = computeQueueInsertIndex(prev, {
        currentRelPath: currentRef.current?.relPath ?? null,
        currentIndex: indexRef.current,
        crossfadeBusy: crossfadeBusyRef.current,
        crossfadeNextIndex: crossfadeNextIdxRef.current,
        manualQueuedPaths: manualQueuedRef.current,
      });
      const sp = Math.max(0, MAX_QUEUE_LENGTH - prev.length);
      const add = items.slice(0, sp);
      if (!add.length) return;
      if (shuffleRef.current) {
        const paths =
          preShuffleRelPathsRef.current ?? prev.map((t) => t.relPath);
        preShuffleRelPathsRef.current = insertTracksInQueue(
          paths.map((relPath) => ({ relPath })),
          add.map((t) => ({ relPath: t.relPath })),
          at,
        ).map((entry) => entry.relPath);
      }
      for (const t of add) manualQueuedRef.current.add(t.relPath);
      const next = insertTracksInQueue(prev, add, at);
      queueRef.current = next;
      setQueue(next);
    },
    [],
  );

  const removeFromQueue = useCallback((index: number) => {
    const snapshot = queueRef.current;
    const currentAt = indexRef.current;
    const removedPath = snapshot[index]?.relPath;
    if (removedPath) manualQueuedRef.current.delete(removedPath);
    const nextQueue = snapshot.filter((_, itemIndex) => itemIndex !== index);
    setQueue(nextQueue);
    if (shuffleRef.current && preShuffleRelPathsRef.current && removedPath) {
      preShuffleRelPathsRef.current = preShuffleRelPathsRef.current.filter(
        (p) => p !== removedPath,
      );
    }
    const idxChange = computeIndexAfterRemove(index, currentAt);
    if (idxChange === "current_removed") {
      if (!nextQueue.length) {
        queueRemainderRef.current = null;
        setCurrent(null);
        setCurrentIndex(0);
        keepPlayingRef.current = false;
        audioDeck0Ref.current?.pause();
        audioDeck1Ref.current?.pause();
        setIsPlaying(false);
        return;
      }
      const nextIndex = Math.min(index, nextQueue.length - 1);
      setCurrent(nextQueue[nextIndex] || null);
      setCurrentIndex(nextIndex);
      return;
    }
    if (typeof idxChange === "number") setCurrentIndex(idxChange);
  }, []);

  const isTrackInQueue = useCallback(
    (relPath: string) => queue.some((t) => t.relPath === relPath),
    [queue],
  );

  const removeFromQueueByRelPath = useCallback(
    (relPath: string) => {
      const i = queueRef.current.findIndex((t) => t.relPath === relPath);
      if (i < 0) return;
      removeFromQueue(i);
    },
    [removeFromQueue],
  );

  const moveQueueItem = useCallback((from: number, to: number) => {
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= queueRef.current.length ||
      to >= queueRef.current.length
    ) {
      return;
    }
    const nextQueue = reorder(queueRef.current, from, to);
    const active = indexRef.current;
    setQueue(nextQueue);
    setCurrentIndex(computeIndexAfterMove(from, to, active));
  }, []);

  const clearQueue = useCallback(() => {
    preShuffleRelPathsRef.current = null;
    queueRemainderRef.current = null;
    manualQueuedRef.current.clear();
    void abortCrossfade();
    audioDeck0Ref.current?.pause();
    audioDeck1Ref.current?.pause();
    setQueue([]);
    setCurrentIndex(0);
    setCurrent(null);
    keepPlayingRef.current = false;
    setIsPlaying(false);
  }, [abortCrossfade]);

  const resyncTracksFromIndex = useCallback((libraryIndex: LibraryIndex) => {
    const tracks = libraryIndex.tracks as EnrichedTrack[];
    setQueue((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const full = resolveTrackFromLibrary(t, tracks);
        if (full === t || !enrichedTracksNeedPlayerResync(t, full)) return t;
        changed = true;
        return full;
      });
      return changed ? next : prev;
    });
    setCurrent((c) => {
      if (!c) return c;
      const full = resolveTrackFromLibrary(c, tracks);
      if (full === c || !enrichedTracksNeedPlayerResync(c, full)) return c;
      return full;
    });
  }, []);

  const next = useCallback(() => {
    if (crossfadeBusyRef.current) {
      finalizeCrossfade();
      syncMediaSessionNowRef.current();
      return;
    }
    if (!queue.length) return;
    const nextIndex = resolveNextPlaybackIndex(currentIndex);
    if (nextIndex == null) {
      keepPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const nextTr = queueRef.current[nextIndex];
    if (nextTr && current?.relPath === nextTr.relPath) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        setCurrentTime(0);
        setPlayerProgressTime(0, true);
        keepPlayingRef.current = true;
        void audio.play().catch(() => setIsPlaying(false));
      }
      syncMediaSessionNowRef.current();
      return;
    }
    setCurrentIndex(nextIndex);
    pendingTrackTransitionRef.current = true;
    setCurrent(nextTr || null);
    keepPlayingRef.current = true;
    syncMediaSessionNowRef.current();
  }, [current, currentIndex, finalizeCrossfade, queue.length, resolveNextPlaybackIndex]);

  const setShuffle = useCallback((enable: boolean) => {
    if (!enable) {
      const paths = preShuffleRelPathsRef.current;
      preShuffleRelPathsRef.current = null;
      setShuffleState(false);
      if (!paths?.length) return;
      const q = queueRef.current;
      const idx = indexRef.current;
      const cur = q[idx];
      const { items, index: i } = restoreQueueFromShufflePaths(
        q,
        paths,
        cur?.relPath ?? null,
      );
      if (!items.length) return;
      setQueue(items);
      setCurrentIndex(i);
      setCurrent(items[i] || null);
      return;
    }
    setShuffleState(true);
    const q = queueRef.current;
    const idx = indexRef.current;
    if (q.length < 2) return;
    preShuffleRelPathsRef.current = q.map((t) => t.relPath);
    const shuffled = shuffleTailFromCurrent(q, idx);
    setQueue(shuffled);
    setCurrentIndex(idx);
    setCurrent(shuffled[idx] || null);
  }, []);

  const playQueueIndex = useCallback(
    (index: number) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;
      void abortCrossfade();
      setCurrentIndex(index);
      pendingTrackTransitionRef.current = true;
      setCurrent(q[index] || null);
      keepPlayingRef.current = true;
      syncMediaSessionNowRef.current();
    },
    [abortCrossfade],
  );

  const prev = useCallback(() => {
    if (!queue.length) return;
    const crossfade = abortCrossfade();
    if (!crossfade.wasActive) {
      const audio = audioRef.current;
      if (audio && audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
      }
    }
    const prevIndex = resolvePrevIndex(queue.length, currentIndex, repeat);
    if (prevIndex == null) return;
    setCurrentIndex(prevIndex);
    pendingTrackTransitionRef.current = true;
    setCurrent(queue[prevIndex] || null);
    keepPlayingRef.current = true;
    syncMediaSessionNowRef.current();
  }, [abortCrossfade, currentIndex, queue, repeat]);

  const { toggleFavorite, toggleShuffleExcludedTrack } = user;
  const shuffleExcludedAlbumIds = user.state.shuffleExcludedAlbumIds;
  useEffect(() => {
    mediaBridgeRef.current = buildMediaBridge({
      playForMediaSession,
      pauseForMediaSession,
      applyMediaMute: applyMediaMuteCb,
      keepPlayingRef,
      audioRef,
      play,
      next,
      prev,
      playQueueIndex,
      seek,
      shuffleRef,
      setShuffle,
      setRepeat,
      currentRef,
      toggleFavorite,
      toggleShuffleExcludedTrack,
      shuffleExcludedAlbumIds,
      isTrackAlbumShuffleExcluded,
    });
  }, [
    applyMediaMuteCb,
    play,
    playForMediaSession,
    pauseForMediaSession,
    next,
    playQueueIndex,
    prev,
    seek,
    setShuffle,
    setRepeat,
    toggleFavorite,
    toggleShuffleExcludedTrack,
    shuffleExcludedAlbumIds,
  ]);

  useEffect(() => {
    return registerMediaSessionActions(() => mediaBridgeRef.current);
  }, []);

  useEffect(() => {
    if (!current) {
      lastMediaPosAtRef.current = 0;
      lastMediaRelPathRef.current = null;
      syncMediaSessionNow();
      return;
    }
    if (current.relPath !== lastMediaRelPathRef.current) {
      lastMediaRelPathRef.current = current.relPath;
      lastMediaPosAtRef.current = 0;
    }
    syncMediaSessionNow();
  }, [current, syncMediaSessionNow]);

  useEffect(() => {
    if (!current) return;
    syncMediaSessionNow();
    const ms = isPlaying ? 1000 : 2500;
    const id = window.setInterval(() => syncMediaSessionNow(), ms);
    return () => window.clearInterval(id);
  }, [current, isPlaying, syncMediaSessionNow]);

  const trackRowListenersRef = useRef<Set<() => void>>(new Set());
  const trackRowSnapRef = useRef<{
    currentRelPath: string | null;
    queueSet: Set<string>;
  }>({ currentRelPath: null, queueSet: new Set() });
  const trackRowActionsRef = useRef({ addToQueue, removeFromQueueByRelPath });
  useEffect(() => {
    trackRowActionsRef.current = { addToQueue, removeFromQueueByRelPath };
  }, [addToQueue, removeFromQueueByRelPath]);
  useEffect(() => {
    trackRowSnapRef.current = {
      currentRelPath: current?.relPath ?? null,
      queueSet: new Set(queue.map((t) => t.relPath)),
    };
    for (const listener of trackRowListenersRef.current) listener();
  }, [current, queue]);
  const trackRowStore = useMemo<TrackRowPlayerStore>(
    () => ({
      subscribe: (listener) => {
        trackRowListenersRef.current.add(listener);
        return () => {
          trackRowListenersRef.current.delete(listener);
        };
      },
      getCurrentRelPath: () => trackRowSnapRef.current.currentRelPath,
      isInQueue: (relPath) => trackRowSnapRef.current.queueSet.has(relPath),
      addToQueue: (t) => trackRowActionsRef.current.addToQueue(t),
      removeFromQueueByRelPath: (relPath) =>
        trackRowActionsRef.current.removeFromQueueByRelPath(relPath),
    }),
    [],
  );

  const value = useMemo<PlayerContextValue>(
    () => ({
      audioRef,
      getAnalyser,
      current,
      queue,
      currentIndex,
      isPlaying,
      currentTime,
      duration,
      volume,
      repeat,
      shuffle,
      favorites: user.favorites,
      play: () => {
        void play();
      },
      pause,
      toggle,
      setRepeat,
      setShuffle,
      seek,
      seekRatio,
      playTrack,
      replaceQueueKeepingPlayback,
      playAlbum,
      addToQueue,
      removeFromQueue,
      isTrackInQueue,
      removeFromQueueByRelPath,
      moveQueueItem,
      clearQueue,
      next,
      prev,
      toggleFavorite: user.toggleFavorite,
      isFavorite: user.isFavorite,
      resyncTracksFromIndex,
      syncMediaSessionNow,
      sleepTimerEndsAt,
      setSleepTimer,
    }),
    [
      getAnalyser,
      addToQueue,
      clearQueue,
      isTrackInQueue,
      removeFromQueueByRelPath,
      resyncTracksFromIndex,
      syncMediaSessionNow,
      current,
      currentIndex,
      currentTime,
      duration,
      isPlaying,
      moveQueueItem,
      next,
      pause,
      play,
      playAlbum,
      playTrack,
      replaceQueueKeepingPlayback,
      prev,
      queue,
      removeFromQueue,
      repeat,
      seek,
      seekRatio,
      setShuffle,
      shuffle,
      toggle,
      user.favorites,
      user.isFavorite,
      user.toggleFavorite,
      volume,
      sleepTimerEndsAt,
      setSleepTimer,
    ],
  );

  return (
    <PlayerContext.Provider value={value}>
      <TrackRowPlayerContext.Provider value={trackRowStore}>
        {children}
        <audio ref={audioDeck0Ref} hidden preload="auto" crossOrigin="anonymous" />
        <audio ref={audioDeck1Ref} hidden preload="auto" crossOrigin="anonymous" />
      </TrackRowPlayerContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer");
  return ctx;
}

export function useTrackRowPlayer(relPath: string) {
  const store = useContext(TrackRowPlayerContext);
  if (!store) throw new Error("useTrackRowPlayer");
  const isCurrent = useSyncExternalStore(
    store.subscribe,
    () => store.getCurrentRelPath() === relPath,
  );
  const inQueue = useSyncExternalStore(
    store.subscribe,
    () => store.isInQueue(relPath),
  );
  return {
    isCurrent,
    inQueue,
    addToQueue: store.addToQueue,
    removeFromQueueByRelPath: store.removeFromQueueByRelPath,
  };
}
