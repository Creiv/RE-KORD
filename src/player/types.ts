import type { RefObject } from "react";
import type { EnrichedTrack, LibAlbum, LibraryIndex, RepeatMode } from "../types";

export type DeckIx = 0 | 1;

export const FIXED_VOLUME = 1;
export const MAX_QUEUE_LENGTH = 500;

export type PlayerContextValue = {
  audioRef: RefObject<HTMLAudioElement | null>;
  getAnalyser: () => AnalyserNode | null;
  current: EnrichedTrack | null;
  queue: EnrichedTrack[];
  currentIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  favorites: Set<string>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setRepeat: (m: RepeatMode) => void;
  setShuffle: (v: boolean) => void;
  seek: (t: number) => void;
  seekRatio: (r: number) => void;
  playTrack: (
    t: EnrichedTrack,
    list?: EnrichedTrack[],
    at?: number,
    opts?: { preserveQueueOrder?: boolean; refillRemainder?: EnrichedTrack[] },
  ) => void;
  replaceQueueKeepingPlayback: (
    fullQueue: EnrichedTrack[],
    opts?: { refillRemainder?: EnrichedTrack[] },
  ) => void;
  playAlbum: (artist: string, al: LibAlbum) => void;
  addToQueue: (t: EnrichedTrack | EnrichedTrack[]) => void;
  removeFromQueue: (index: number) => void;
  isTrackInQueue: (relPath: string) => boolean;
  removeFromQueueByRelPath: (relPath: string) => void;
  moveQueueItem: (from: number, to: number) => void;
  clearQueue: () => void;
  next: () => void;
  prev: () => void;
  toggleFavorite: (relPath: string) => void;
  isFavorite: (relPath: string) => boolean;
  resyncTracksFromIndex: (index: LibraryIndex) => void;
  syncMediaSessionNow: () => void;
  sleepTimerEndsAt: number | null;
  setSleepTimer: (minutes: number | null) => void;
};

export type TrackRowPlayerStore = {
  subscribe: (listener: () => void) => () => void;
  getCurrentRelPath: () => string | null;
  isInQueue: (relPath: string) => boolean;
  addToQueue: (t: EnrichedTrack | EnrichedTrack[]) => void;
  removeFromQueueByRelPath: (relPath: string) => void;
};

export type CrossfadeAbortResult = {
  wasActive: boolean;
  incomingIdx: number | null;
  incomingDeckIx: DeckIx | null;
  outgoingDeckIx: DeckIx | null;
};

export type AppConfigSnapshot = {
  lanAccessUrl: string | null;
  remotePublicUrl: string | null;
};

export type AudioGraphHandles = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  gain0: GainNode;
  gain1: GainNode;
  outputGain: GainNode;
};
