import type { RefObject } from "react";
import { trackPlaybackKey } from "../lib/libraryNav";
import { mediaUrlForTrack } from "../lib/api";
import type { AudioCrossfadeSec, EnrichedTrack } from "../types";
import type {
  AudioGraphHandles,
  CrossfadeAbortResult,
  DeckIx,
} from "./types";

export function deckAudio(
  ix: DeckIx,
  d0: HTMLAudioElement | null,
  d1: HTMLAudioElement | null,
): HTMLAudioElement | null {
  return ix === 0 ? d0 : d1;
}

export function audioReadyEnough(audio: HTMLAudioElement): boolean {
  return audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

export function waitForAudioReady(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (audioReadyEnough(audio)) {
      resolve();
      return;
    }
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("audio load failed"));
    };
    const cleanup = () => {
      audio.removeEventListener("canplaythrough", done);
      audio.removeEventListener("loadeddata", done);
      audio.removeEventListener("error", fail);
    };
    audio.addEventListener("canplaythrough", done, { once: true });
    audio.addEventListener("loadeddata", done, { once: true });
    audio.addEventListener("error", fail, { once: true });
  });
}

export function setupDualDeckAudioGraph(
  a0: HTMLAudioElement,
  a1: HTMLAudioElement,
): AudioGraphHandles | null {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }

  let src0: MediaElementAudioSourceNode;
  let src1: MediaElementAudioSourceNode;
  try {
    src0 = ctx.createMediaElementSource(a0);
    src1 = ctx.createMediaElementSource(a1);
  } catch {
    void ctx.close();
    return null;
  }

  const g0 = ctx.createGain();
  const g1 = ctx.createGain();
  g0.gain.value = 1;
  g1.gain.value = 0;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.62;
  analyser.minDecibels = -88;
  analyser.maxDecibels = -28;

  const outputGain = ctx.createGain();
  outputGain.gain.value = 1;

  src0.connect(g0);
  src1.connect(g1);
  g0.connect(outputGain);
  g1.connect(outputGain);
  outputGain.connect(analyser);
  analyser.connect(ctx.destination);

  return { ctx, analyser, gain0: g0, gain1: g1, outputGain };
}

export function snapGainsToSolo(
  ctx: AudioContext | null,
  g0: GainNode | null,
  g1: GainNode | null,
  ix: DeckIx,
): void {
  if (!ctx || !g0 || !g1) return;
  const t = ctx.currentTime;
  g0.gain.cancelScheduledValues(t);
  g1.gain.cancelScheduledValues(t);
  if (ix === 0) {
    g0.gain.setValueAtTime(1, t);
    g1.gain.setValueAtTime(0, t);
  } else {
    g0.gain.setValueAtTime(0, t);
    g1.gain.setValueAtTime(1, t);
  }
}

export type CrossfadeManagerRefs = {
  audioDeck0Ref: RefObject<HTMLAudioElement | null>;
  audioDeck1Ref: RefObject<HTMLAudioElement | null>;
  gain0Ref: RefObject<GainNode | null>;
  gain1Ref: RefObject<GainNode | null>;
  audioCtxRef: RefObject<AudioContext | null>;
  activeDeckRef: RefObject<DeckIx>;
  queueRef: RefObject<EnrichedTrack[]>;
  currentRef: RefObject<EnrichedTrack | null>;
  crossfadeBusyRef: RefObject<boolean>;
  crossfadeOutIxRef: RefObject<DeckIx | null>;
  crossfadeInIxRef: RefObject<DeckIx | null>;
  crossfadeNextIdxRef: RefObject<number | null>;
  crossfadeGenRef: RefObject<number>;
  crossfadeTimerRef: RefObject<number>;
  prefetchedRelPathRef: RefObject<string | null>;
  skipNextCurrentLoadRef: RefObject<boolean>;
  audioCrossfadeSecRef: RefObject<AudioCrossfadeSec>;
  repeatRef: RefObject<"off" | "all" | "one">;
  indexRef: RefObject<number>;
  keepPlayingRef: RefObject<boolean>;
  mediaSessionAudibleTrackRef: RefObject<EnrichedTrack | null>;
  pendingTrackTransitionRef: RefObject<boolean>;
};

export type CrossfadeManagerCallbacks = {
  setActiveDeckIx: (ix: DeckIx) => void;
  setCurrentIndex: (i: number) => void;
  setCurrent: (t: EnrichedTrack | null) => void;
  setDuration: (d: number) => void;
  setCurrentTime: (t: number) => void;
  setPlayerProgressTime: (t: number, force?: boolean) => void;
  setIsPlaying: (v: boolean) => void;
  pushRecent: (t: EnrichedTrack) => void;
  resolveNextPlaybackIndex: (baseIndex: number) => number | null;
};

export function createCrossfadeManager(
  refs: CrossfadeManagerRefs,
  callbacks: CrossfadeManagerCallbacks,
) {
  const snap = (ix: DeckIx) =>
    snapGainsToSolo(
      refs.audioCtxRef.current,
      refs.gain0Ref.current,
      refs.gain1Ref.current,
      ix,
    );

  const finalizeCrossfade = () => {
    if (!refs.crossfadeBusyRef.current) return;
    window.clearTimeout(refs.crossfadeTimerRef.current);
    refs.crossfadeTimerRef.current = 0;

    const outIx = refs.crossfadeOutIxRef.current;
    const inIx = refs.crossfadeInIxRef.current;
    const nextIdx = refs.crossfadeNextIdxRef.current;
    refs.crossfadeOutIxRef.current = null;
    refs.crossfadeInIxRef.current = null;
    refs.crossfadeNextIdxRef.current = null;
    refs.crossfadeBusyRef.current = false;

    if (outIx == null || inIx == null || nextIdx == null) {
      snap(refs.activeDeckRef.current);
      return;
    }

    const nextTr = refs.queueRef.current[nextIdx];
    if (!nextTr) {
      snap(refs.activeDeckRef.current);
      return;
    }

    const outEl = deckAudio(
      outIx,
      refs.audioDeck0Ref.current,
      refs.audioDeck1Ref.current,
    );
    if (!outEl) {
      snap(refs.activeDeckRef.current);
      return;
    }

    outEl.pause();
    outEl.removeAttribute("src");
    void outEl.load();

    const ctx = refs.audioCtxRef.current;
    const gOut = outIx === 0 ? refs.gain0Ref.current : refs.gain1Ref.current;
    const gIn = inIx === 0 ? refs.gain0Ref.current : refs.gain1Ref.current;
    if (ctx && gOut && gIn) {
      const t = ctx.currentTime;
      gOut.gain.cancelScheduledValues(t);
      gIn.gain.cancelScheduledValues(t);
    }
    snap(inIx);

    const inEl = deckAudio(
      inIx,
      refs.audioDeck0Ref.current,
      refs.audioDeck1Ref.current,
    );
    const relPathChanged = nextTr.relPath !== refs.currentRef.current?.relPath;
    refs.prefetchedRelPathRef.current = trackPlaybackKey(nextTr);

    refs.activeDeckRef.current = inIx;
    callbacks.setActiveDeckIx(inIx);
    if (relPathChanged) {
      refs.skipNextCurrentLoadRef.current = true;
    } else if (inEl) {
      if (Number.isFinite(inEl.duration) && inEl.duration > 0) {
        callbacks.setDuration(inEl.duration);
      }
      const t = inEl.currentTime;
      callbacks.setCurrentTime(t);
      callbacks.setPlayerProgressTime(t, true);
    }
    callbacks.setCurrentIndex(nextIdx);
    callbacks.setCurrent(nextTr);
    refs.keepPlayingRef.current = true;
    refs.mediaSessionAudibleTrackRef.current = nextTr;
    refs.pendingTrackTransitionRef.current = false;
    callbacks.pushRecent(nextTr);
    if (inEl && !inEl.paused) callbacks.setIsPlaying(true);
  };

  const abortCrossfade = (): CrossfadeAbortResult => {
    const wasActive = refs.crossfadeBusyRef.current;
    const incomingIdx = refs.crossfadeNextIdxRef.current;
    const incomingDeckIx = refs.crossfadeInIxRef.current;
    const outgoingDeckIx = refs.crossfadeOutIxRef.current;

    refs.crossfadeGenRef.current += 1;
    window.clearTimeout(refs.crossfadeTimerRef.current);
    refs.crossfadeTimerRef.current = 0;
    refs.crossfadeBusyRef.current = false;
    refs.crossfadeOutIxRef.current = null;
    refs.crossfadeInIxRef.current = null;
    refs.crossfadeNextIdxRef.current = null;

    const ctx = refs.audioCtxRef.current;
    const g0 = refs.gain0Ref.current;
    const g1 = refs.gain1Ref.current;
    if (ctx && g0 && g1) {
      const t = ctx.currentTime;
      g0.gain.cancelScheduledValues(t);
      g1.gain.cancelScheduledValues(t);
    }
    snap(refs.activeDeckRef.current);

    const a = refs.activeDeckRef.current;
    const inIx: DeckIx = a === 0 ? 1 : 0;
    const inactiveEl = deckAudio(
      inIx,
      refs.audioDeck0Ref.current,
      refs.audioDeck1Ref.current,
    );
    if (inactiveEl) {
      inactiveEl.pause();
      inactiveEl.removeAttribute("src");
      void inactiveEl.load();
    }
    refs.prefetchedRelPathRef.current = null;

    return { wasActive, incomingIdx, incomingDeckIx, outgoingDeckIx };
  };

  const prefetchNextOnInactiveDeck = () => {
    if (refs.crossfadeBusyRef.current) return;
    if (refs.audioCrossfadeSecRef.current > 0) return;
    if (refs.repeatRef.current === "one") return;
    const idx = refs.indexRef.current;
    const nextIdx = callbacks.resolveNextPlaybackIndex(idx);
    if (nextIdx == null) return;
    const nextTr = refs.queueRef.current[nextIdx];
    if (!nextTr) return;
    const outIx = refs.activeDeckRef.current;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl = deckAudio(
      outIx,
      refs.audioDeck0Ref.current,
      refs.audioDeck1Ref.current,
    );
    const inEl = deckAudio(
      inIx,
      refs.audioDeck0Ref.current,
      refs.audioDeck1Ref.current,
    );
    if (!outEl || !inEl) return;
    const d = outEl.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const remain = d - outEl.currentTime;
    if (remain > 12 || remain < 0.25) return;
    const path = trackPlaybackKey(nextTr);
    if (refs.prefetchedRelPathRef.current === path && audioReadyEnough(inEl))
      return;
    refs.prefetchedRelPathRef.current = path;
    inEl.src = mediaUrlForTrack(nextTr);
    inEl.load();
  };

  const startCrossfade = async () => {
    const sec = refs.audioCrossfadeSecRef.current;
    if (!sec) return;
    if (refs.crossfadeBusyRef.current) return;
    if (refs.repeatRef.current === "one") return;

    const idx = refs.indexRef.current;
    const nextIdx = callbacks.resolveNextPlaybackIndex(idx);
    if (nextIdx == null) return;

    const outIx = refs.activeDeckRef.current;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl =
      outIx === 0 ? refs.audioDeck0Ref.current : refs.audioDeck1Ref.current;
    const inEl =
      inIx === 0 ? refs.audioDeck0Ref.current : refs.audioDeck1Ref.current;
    if (!outEl || !inEl) return;

    const d = outEl.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const ct = outEl.currentTime;
    const fadeWindow = Math.min(sec, d);
    if (ct < d - fadeWindow - 0.02) return;
    const remain = d - ct;
    if (remain < 0.08) return;

    const nextTr = refs.queueRef.current[nextIdx];
    if (!nextTr) return;

    const ctx = refs.audioCtxRef.current;
    const gOut = outIx === 0 ? refs.gain0Ref.current : refs.gain1Ref.current;
    const gIn = inIx === 0 ? refs.gain0Ref.current : refs.gain1Ref.current;
    if (!ctx || !gOut || !gIn) return;

    refs.crossfadeBusyRef.current = true;
    refs.crossfadeOutIxRef.current = outIx;
    refs.crossfadeInIxRef.current = inIx;
    refs.crossfadeNextIdxRef.current = nextIdx;

    inEl.src = mediaUrlForTrack(nextTr);
    inEl.load();
    refs.prefetchedRelPathRef.current = trackPlaybackKey(nextTr);

    try {
      if (ctx.state === "suspended") await ctx.resume();
      inEl.currentTime = 0;
      await inEl.play();
    } catch {
      refs.crossfadeBusyRef.current = false;
      refs.crossfadeOutIxRef.current = null;
      refs.crossfadeInIxRef.current = null;
      refs.crossfadeNextIdxRef.current = null;
      snap(outIx);
      inEl.pause();
      inEl.removeAttribute("src");
      void inEl.load();
      return;
    }

    if (!refs.crossfadeBusyRef.current) return;

    const fadeLen = Math.min(sec, Math.max(remain, 0.05));
    const token = refs.crossfadeGenRef.current;
    const now = ctx.currentTime;
    const vOut = gOut.gain.value;
    const vIn = gIn.gain.value;
    gOut.gain.cancelScheduledValues(now);
    gIn.gain.cancelScheduledValues(now);
    gOut.gain.setValueAtTime(vOut, now);
    gIn.gain.setValueAtTime(vIn, now);
    gOut.gain.linearRampToValueAtTime(0, now + fadeLen);
    gIn.gain.linearRampToValueAtTime(1, now + fadeLen);

    refs.crossfadeTimerRef.current = window.setTimeout(() => {
      if (token !== refs.crossfadeGenRef.current) return;
      finalizeCrossfade();
    }, fadeLen * 1000 + 40);
  };

  return {
    snapGainsToSolo: snap,
    finalizeCrossfade,
    abortCrossfade,
    prefetchNextOnInactiveDeck,
    startCrossfade,
  };
}
