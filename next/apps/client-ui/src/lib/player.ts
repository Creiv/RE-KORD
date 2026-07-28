import { mediaUrl } from "./config";
import type { Track } from "./api";
import { touchListeningActivity } from "./achievements";
import {
  buildRadioFromSeed,
  buildSmartRandomQueue,
  CARD_QUEUE_CAP,
} from "./smartShuffle";
import {
  loadUserPrefs,
  patchUserPrefs,
  playCountFor,
  type CrossfadeSec,
} from "./userPrefs";

export type RepeatMode = "off" | "all" | "one";

type Listener = () => void;
type DeckIx = 0 | 1;

const SLEEP_FADE_MS = 30_000;
const SLEEP_FADE_INTERVAL_MS = 180;
/** Always-on listening session: queue + currentIndex (not seek/volume/view). */
const SESSION_QUEUE_KEY = "rekord.next.sessionQueue";
const SESSION_QUEUE_PERSIST_MS = 300;

type PersistedSessionQueue = {
  version: 1;
  tracks: Track[];
  currentIndex: number;
};

function isTrackLike(v: unknown): v is Track {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<Track>;
  return (
    typeof t.rel_path === "string" &&
    t.rel_path.length > 0 &&
    typeof t.id === "number" &&
    typeof t.title === "string"
  );
}

function loadPersistedSessionQueue(): PersistedSessionQueue | null {
  try {
    const raw = localStorage.getItem(SESSION_QUEUE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSessionQueue> & {
      relPaths?: string[];
    };
    let tracks: Track[] = [];
    if (Array.isArray(parsed.tracks)) {
      tracks = parsed.tracks.filter(isTrackLike);
    } else if (Array.isArray(parsed.relPaths)) {
      // Older shape: only paths — restore needs catalog remap.
      tracks = parsed.relPaths
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map(
          (rel_path, i) =>
            ({
              id: -1 - i,
              rel_path,
              title: rel_path.split("/").pop() || rel_path,
              artist_name: "",
              album_name: "",
              duration_ms: 0,
              track_number: null,
              album_id: null,
              artist_id: null,
            }) satisfies Track,
        );
    }
    if (!tracks.length) return null;
    const currentIndex =
      typeof parsed.currentIndex === "number" && Number.isFinite(parsed.currentIndex)
        ? Math.max(0, Math.floor(parsed.currentIndex))
        : 0;
    return { version: 1, tracks, currentIndex };
  } catch {
    return null;
  }
}

function savePersistedSessionQueue(queue: Track[], currentIndex: number) {
  if (!queue.length) {
    localStorage.removeItem(SESSION_QUEUE_KEY);
    return;
  }
  const payload: PersistedSessionQueue = {
    version: 1,
    tracks: queue.map((t) => ({ ...t })),
    currentIndex: Math.max(0, Math.min(currentIndex, queue.length - 1)),
  };
  localStorage.setItem(SESSION_QUEUE_KEY, JSON.stringify(payload));
}

class PlayerController {
  private deck0 = new Audio();
  private deck1 = new Audio();
  private active: DeckIx = 0;
  private ctx: AudioContext | null = null;
  private gain0: GainNode | null = null;
  private gain1: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private graphReady = false;
  private crossfadeBusy = false;
  private crossfadeTimer = 0;
  private crossfadeGen = 0;
  private crossfadeOutIx: DeckIx | null = null;
  private crossfadeInIx: DeckIx | null = null;
  private crossfadeNextIdx: number | null = null;
  private prefetchedRelPath: string | null = null;
  private listeners = new Set<Listener>();

  queue: Track[] = [];
  index = -1;
  playing = false;
  currentTime = 0;
  duration = 0;
  shuffle = false;
  repeat: RepeatMode = "all";
  crossfadeSec: CrossfadeSec = 3;
  sleepTimerEndsAt: number | null = null;
  private privateQueue: Track[] = [];
  private sleepTimeout = 0;
  private sleepFadeInterval = 0;
  private excludedRelPaths = new Set<string>();
  private excludedAlbumIds = new Set<number>();
  private lastPlayCountPath: string | null = null;
  private persistQueueTimer = 0;
  private lastQueuePersistSig = "";
  private restoringSession = false;
  private sessionRestored = false;

  constructor() {
    const prefs = loadUserPrefs();
    this.crossfadeSec = prefs.crossfadeSec;
    this.excludedRelPaths = new Set(prefs.excludedRelPaths);
    this.excludedAlbumIds = new Set(prefs.excludedAlbumIds);

    for (const a of [this.deck0, this.deck1]) {
      a.preload = "auto";
      a.crossOrigin = "anonymous";
    }
    this.bindDeck(this.deck0, 0);
    this.bindDeck(this.deck1, 1);

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => this.flushPersistQueue());
    }
  }

  private bindDeck(audio: HTMLAudioElement, ix: DeckIx) {
    audio.addEventListener("timeupdate", () => {
      if (this.crossfadeBusy) {
        // Keep UI moving during fade (outgoing until swap).
        if (this.crossfadeOutIx === ix) {
          this.currentTime = audio.currentTime;
          this.emit();
        }
        return;
      }
      if (ix !== this.active) return;
      this.currentTime = audio.currentTime;
      this.prefetchNextDeck();
      this.maybeStartCrossfade();
      this.emit();
    });
    audio.addEventListener("durationchange", () => {
      if (this.crossfadeBusy && this.crossfadeInIx === ix) {
        this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        this.emit();
        return;
      }
      if (ix !== this.active) return;
      this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.emit();
    });
    audio.addEventListener("play", () => {
      if (this.crossfadeBusy) {
        if (this.crossfadeInIx === ix || this.crossfadeOutIx === ix) {
          this.playing = true;
          this.emit();
        }
        return;
      }
      if (ix !== this.active) return;
      this.playing = true;
      this.emit();
    });
    audio.addEventListener("pause", () => {
      if (ix !== this.active || this.crossfadeBusy) return;
      this.playing = false;
      this.emit();
    });
    audio.addEventListener("ended", () => {
      if (this.crossfadeBusy) {
        if (ix === this.crossfadeOutIx) this.finalizeCrossfade();
        return;
      }
      if (ix !== this.active) return;
      void this.onEnded();
    });
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.schedulePersistQueue();
    for (const fn of this.listeners) fn();
  }

  private queuePersistSig() {
    if (!this.queue.length || this.index < 0) return "";
    return `${this.index}\0${this.queue.map((t) => t.rel_path).join("\0")}`;
  }

  private schedulePersistQueue() {
    if (this.restoringSession) return;
    const sig = this.queuePersistSig();
    if (sig === this.lastQueuePersistSig) return;
    if (this.persistQueueTimer) window.clearTimeout(this.persistQueueTimer);
    this.persistQueueTimer = window.setTimeout(() => {
      this.persistQueueTimer = 0;
      this.flushPersistQueue();
    }, SESSION_QUEUE_PERSIST_MS);
  }

  /** Flush queue + currentIndex to localStorage (always on, like legacy enqueueQueuePatch). */
  flushPersistQueue() {
    if (this.restoringSession) return;
    if (this.persistQueueTimer) {
      window.clearTimeout(this.persistQueueTimer);
      this.persistQueueTimer = 0;
    }
    const sig = this.queuePersistSig();
    if (sig === this.lastQueuePersistSig) return;
    this.lastQueuePersistSig = sig;
    savePersistedSessionQueue(this.queue, this.index);
  }

  /**
   * Restore queue + currentIndex. Always on (ignores prefs.restoreSession).
   * Does not restore seek position, volume, or UI view; does not autoplay.
   * Remaps ids from catalog when available; keeps snapshots otherwise.
   */
  restorePersistedQueue(catalog: Track[] = []): boolean {
    if (this.sessionRestored) return false;
    const persisted = loadPersistedSessionQueue();
    if (!persisted?.tracks.length) {
      this.sessionRestored = true;
      return false;
    }
    this.sessionRestored = true;
    return this.hydrateQueueSnapshot(persisted.tracks, persisted.currentIndex, catalog);
  }

  /** Restore queue from rel paths (backup/user-state) without autoplay. */
  hydrateQueueFromRelPaths(
    relPaths: string[],
    currentIndex: number,
    catalog: Track[] = [],
  ): boolean {
    if (!relPaths.length) return false;
    const tracks = relPaths.map((rel_path, i) => ({
      id: -1 - i,
      rel_path,
      title: rel_path.split("/").pop() || rel_path,
      artist_name: "",
      album_name: "",
      duration_ms: 0,
      track_number: null,
      album_id: null,
      artist_id: null,
    })) satisfies Track[];
    this.sessionRestored = true;
    return this.hydrateQueueSnapshot(tracks, currentIndex, catalog);
  }

  private hydrateQueueSnapshot(
    snapshot: Track[],
    currentIndex: number,
    catalog: Track[] = [],
  ): boolean {
    if (!snapshot.length) return false;
    const byPath = new Map(catalog.map((t) => [t.rel_path, t]));
    const tracks = snapshot.map((t) => byPath.get(t.rel_path) ?? t);
    const index = Math.max(0, Math.min(currentIndex, tracks.length - 1));

    this.restoringSession = true;
    try {
      this.abortCrossfade();
      this.privateQueue = [...tracks];
      this.queue = [...tracks];
      this.index = index;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 0;
      const track = this.current;
      if (track) {
        const audio = this.activeAudio();
        audio.loop = this.repeat === "one";
        audio.src = mediaUrl(track.rel_path);
        this.updateMediaSession(track);
      }
      this.lastQueuePersistSig = this.queuePersistSig();
      savePersistedSessionQueue(this.queue, this.index);
      this.emit();
    } finally {
      this.restoringSession = false;
    }
    return true;
  }

  get current(): Track | null {
    return this.index >= 0 ? (this.queue[this.index] ?? null) : null;
  }

  get currentIndex() {
    return this.index;
  }

  isInQueue(trackId: number) {
    return this.queue.some((t) => t.id === trackId);
  }

  isTrackExcluded(track: Track) {
    if (this.excludedRelPaths.has(track.rel_path)) return true;
    if (track.album_id != null && this.excludedAlbumIds.has(track.album_id))
      return true;
    return false;
  }

  isAlbumExcluded(albumId: number) {
    return this.excludedAlbumIds.has(albumId);
  }

  getExcludedRelPaths() {
    return this.excludedRelPaths;
  }

  getExcludedAlbumIds() {
    return this.excludedAlbumIds;
  }

  /** Reload exclusion sets after prefs migration (id → rel_path). */
  reloadExclusionsFromPrefs() {
    const prefs = loadUserPrefs();
    this.excludedRelPaths = new Set(prefs.excludedRelPaths);
    this.excludedAlbumIds = new Set(prefs.excludedAlbumIds);
    this.emit();
  }

  private ensureGraph() {
    if (this.graphReady) return;
    try {
      const ctx = new AudioContext();
      const s0 = ctx.createMediaElementSource(this.deck0);
      const s1 = ctx.createMediaElementSource(this.deck1);
      const g0 = ctx.createGain();
      const g1 = ctx.createGain();
      const out = ctx.createGain();
      g0.gain.value = 1;
      g1.gain.value = 0;
      out.gain.value = 1;
      s0.connect(g0);
      s1.connect(g1);
      g0.connect(out);
      g1.connect(out);
      out.connect(ctx.destination);
      this.ctx = ctx;
      this.gain0 = g0;
      this.gain1 = g1;
      this.outputGain = out;
      this.graphReady = true;
    } catch {
      this.graphReady = false;
    }
  }

  private activeAudio() {
    return this.active === 0 ? this.deck0 : this.deck1;
  }

  private snapSolo(ix: DeckIx) {
    if (!this.ctx || !this.gain0 || !this.gain1) return;
    const t = this.ctx.currentTime;
    this.gain0.gain.cancelScheduledValues(t);
    this.gain1.gain.cancelScheduledValues(t);
    this.gain0.gain.setValueAtTime(ix === 0 ? 1 : 0, t);
    this.gain1.gain.setValueAtTime(ix === 1 ? 1 : 0, t);
  }

  private persistExclusions() {
    patchUserPrefs({
      excludedRelPaths: [...this.excludedRelPaths],
      excludedTrackIds: [],
      excludedAlbumIds: [...this.excludedAlbumIds],
    });
  }

  setCrossfadeSec(sec: CrossfadeSec) {
    this.crossfadeSec = sec;
    patchUserPrefs({ crossfadeSec: sec });
    this.emit();
  }

  toggleExcludeTrack(track: Track) {
    if (track.album_id != null && this.excludedAlbumIds.has(track.album_id)) {
      return;
    }
    if (this.excludedRelPaths.has(track.rel_path)) {
      this.excludedRelPaths.delete(track.rel_path);
    } else {
      this.excludedRelPaths.add(track.rel_path);
    }
    this.persistExclusions();
    this.emit();
  }

  toggleExcludeAlbum(albumId: number) {
    if (this.excludedAlbumIds.has(albumId)) this.excludedAlbumIds.delete(albumId);
    else this.excludedAlbumIds.add(albumId);
    this.persistExclusions();
    this.emit();
  }

  private bumpPlayCount(track: Track) {
    if (this.lastPlayCountPath === track.rel_path) return;
    this.lastPlayCountPath = track.rel_path;
    const prefs = loadUserPrefs();
    const key = track.rel_path;
    const prev = playCountFor(prefs, track);
    prefs.playCounts[key] = prev + 1;
    delete prefs.playCounts[String(track.id)];
    const recent = [
      key,
      ...prefs.recentRelPaths.filter((p) => p !== key),
    ].slice(0, 80);
    patchUserPrefs({
      playCounts: prefs.playCounts,
      recentRelPaths: recent,
      recentTrackIds: [],
    });
    touchListeningActivity();
  }

  playCount(track: { id: number; rel_path: string } | number) {
    const prefs = loadUserPrefs();
    if (typeof track === "number") {
      return prefs.playCounts[String(track)] ?? 0;
    }
    return playCountFor(prefs, track);
  }

  recentRelPaths() {
    return loadUserPrefs().recentRelPaths;
  }

  /** @deprecated use recentRelPaths — kept for brief call-site migration */
  recentTrackIds() {
    return [] as number[];
  }

  clearRecent() {
    patchUserPrefs({ recentRelPaths: [], recentTrackIds: [] });
    this.emit();
  }

  allPlayCounts() {
    return loadUserPrefs().playCounts;
  }

  filterShufflePool(tracks: Track[]) {
    return tracks.filter((t) => !this.isTrackExcluded(t));
  }

  playTracks(tracks: Track[], startIndex = 0) {
    if (!tracks.length) return;
    this.abortCrossfade();
    this.privateQueue = [...tracks];
    if (this.shuffle) {
      const start = tracks[Math.min(Math.max(0, startIndex), tracks.length - 1)];
      const rest = this.filterShufflePool(tracks.filter((t) => t.id !== start.id));
      this.queue = [start, ...this.shuffled(rest)];
      this.index = 0;
    } else {
      this.queue = [...this.privateQueue];
      this.index = Math.min(Math.max(0, startIndex), this.queue.length - 1);
    }
    void this.loadCurrent(true);
  }

  playTrack(track: Track, context: Track[] = [track]) {
    const idx = context.findIndex((t) => t.id === track.id);
    this.playTracks(context, idx >= 0 ? idx : 0);
  }

  playShuffled(tracks: Track[], start?: Track) {
    const pool = this.filterShufflePool(tracks);
    if (!pool.length) return;
    const first = start && pool.some((t) => t.id === start.id) ? start : pool[0];
    const rest = pool.filter((t) => t.id !== first.id);
    this.shuffle = true;
    this.privateQueue = [...tracks];
    const recent = new Set(loadUserPrefs().recentRelPaths);
    const smartRest = buildSmartRandomQueue(rest, {
      currentRelPath: first.rel_path,
      currentArtist: first.artist_name,
      recentRelPaths: recent,
    });
    this.queue = [first, ...smartRest].slice(0, CARD_QUEUE_CAP);
    this.index = 0;
    void this.loadCurrent(true);
  }

  /** Smart radio from a seed track across a library pool. */
  playRadioFromSeed(seed: Track, library: Track[]) {
    const pool = this.filterShufflePool(library);
    const recent = new Set(loadUserPrefs().recentRelPaths);
    const queue = buildRadioFromSeed(seed, pool, {
      maxLength: CARD_QUEUE_CAP,
      recentRelPaths: recent,
    });
    if (!queue.length) return;
    this.shuffle = true;
    this.privateQueue = [...queue];
    this.queue = queue;
    this.index = 0;
    void this.loadCurrent(true);
  }

  addToQueue(track: Track | Track[]) {
    const list = Array.isArray(track) ? track : [track];
    if (!list.length) return;
    if (!this.queue.length) {
      this.playTracks(list, 0);
      return;
    }
    const seen = new Set(this.queue.map((t) => t.id));
    const add = list.filter((t) => !seen.has(t.id));
    if (!add.length) return;
    this.queue = [...this.queue, ...add];
    this.privateQueue = [...this.privateQueue, ...add];
    this.emit();
  }

  removeFromQueue(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    const removingCurrent = index === this.index;
    this.queue = this.queue.filter((_, i) => i !== index);
    this.privateQueue = this.queue.slice();
    if (!this.queue.length) {
      this.index = -1;
      this.pauseHard();
      this.emit();
      return;
    }
    if (removingCurrent) {
      this.index = Math.min(index, this.queue.length - 1);
      void this.loadCurrent(this.playing);
    } else if (index < this.index) {
      this.index -= 1;
    }
    this.emit();
  }

  removeFromQueueById(trackId: number) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    if (i >= 0) this.removeFromQueue(i);
  }

  moveQueueItem(from: number, to: number) {
    if (from === to) return;
    if (from < 0 || from >= this.queue.length) return;
    const next = [...this.queue];
    const [item] = next.splice(from, 1);
    const clamped = Math.max(0, Math.min(to, next.length));
    next.splice(clamped, 0, item);
    let idx = this.index;
    if (idx === from) idx = clamped;
    else if (from < idx && clamped >= idx) idx -= 1;
    else if (from > idx && clamped <= idx) idx += 1;
    this.queue = next;
    this.privateQueue = next.slice();
    this.index = idx;
    this.emit();
  }

  clearQueue() {
    this.abortCrossfade();
    this.queue = [];
    this.privateQueue = [];
    this.index = -1;
    this.pauseHard();
    this.currentTime = 0;
    this.duration = 0;
    this.emit();
  }

  async toggle() {
    if (!this.current) return;
    this.ensureGraph();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    const a = this.activeAudio();
    if (a.paused) await a.play();
    else a.pause();
  }

  pause() {
    this.activeAudio().pause();
  }

  private pauseHard() {
    this.deck0.pause();
    this.deck1.pause();
    this.playing = false;
  }

  async next() {
    if (!this.queue.length) return;
    this.abortCrossfade();
    if (this.index < this.queue.length - 1) this.index += 1;
    else if (this.repeat === "all") this.index = 0;
    else return;
    await this.loadCurrent(true);
  }

  async prev() {
    if (!this.queue.length) return;
    this.abortCrossfade();
    if (this.activeAudio().currentTime > 3) {
      this.seek(0);
      return;
    }
    this.index = this.index > 0 ? this.index - 1 : 0;
    await this.loadCurrent(true);
  }

  seek(seconds: number) {
    const a = this.activeAudio();
    a.currentTime = seconds;
    this.currentTime = seconds;
    this.emit();
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const currentId = this.current?.id;
    if (this.shuffle) {
      const cur = this.current;
      const rest = this.filterShufflePool(
        this.privateQueue.filter((t) => t.id !== currentId),
      );
      this.queue = cur ? [cur, ...this.shuffled(rest)] : this.shuffled(rest);
      this.index = cur ? 0 : this.index;
    } else {
      this.queue = [...this.privateQueue];
      if (currentId != null) {
        const i = this.queue.findIndex((t) => t.id === currentId);
        this.index = i >= 0 ? i : 0;
      }
    }
    this.emit();
  }

  setShuffle(v: boolean) {
    if (this.shuffle !== v) this.toggleShuffle();
  }

  cycleRepeat() {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    this.activeAudio().loop = this.repeat === "one";
    this.emit();
  }

  setSleepTimer(minutes: number | null) {
    if (this.sleepTimeout) window.clearTimeout(this.sleepTimeout);
    if (this.sleepFadeInterval) window.clearInterval(this.sleepFadeInterval);
    this.sleepTimeout = 0;
    this.sleepFadeInterval = 0;
    if (this.outputGain) this.outputGain.gain.value = 1;
    else {
      this.deck0.volume = 1;
      this.deck1.volume = 1;
    }
    if (minutes == null || minutes <= 0) {
      this.sleepTimerEndsAt = null;
      this.emit();
      return;
    }
    const endsAt = Date.now() + minutes * 60_000;
    this.sleepTimerEndsAt = endsAt;
    const delay = Math.max(0, endsAt - Date.now() - SLEEP_FADE_MS);
    this.sleepTimeout = window.setTimeout(() => {
      const start = Date.now();
      this.sleepFadeInterval = window.setInterval(() => {
        const elapsed = Date.now() - start;
        const ratio = Math.max(0, 1 - elapsed / SLEEP_FADE_MS);
        if (this.outputGain) this.outputGain.gain.value = ratio;
        else {
          this.deck0.volume = ratio;
          this.deck1.volume = ratio;
        }
        if (elapsed >= SLEEP_FADE_MS) {
          this.setSleepTimer(null);
          this.pause();
        }
      }, SLEEP_FADE_INTERVAL_MS);
    }, delay);
    this.emit();
  }

  private resolveNextIndex(): number | null {
    if (this.repeat === "one") return this.index;
    if (this.index < this.queue.length - 1) return this.index + 1;
    if (this.repeat === "all" && this.queue.length) return 0;
    return null;
  }

  private audioReadyEnough(audio: HTMLAudioElement) {
    return audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  private waitForAudioReady(audio: HTMLAudioElement, timeoutMs = 4000) {
    return new Promise<boolean>((resolve) => {
      if (this.audioReadyEnough(audio)) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("canplaythrough", onReady);
        audio.removeEventListener("loadeddata", onReady);
        audio.removeEventListener("error", onFail);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onFail = () => finish(false);
      const timer = window.setTimeout(() => finish(this.audioReadyEnough(audio)), timeoutMs);
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("canplaythrough", onReady, { once: true });
      audio.addEventListener("loadeddata", onReady, { once: true });
      audio.addEventListener("error", onFail, { once: true });
    });
  }

  private inactiveDeck(): HTMLAudioElement {
    return this.active === 0 ? this.deck1 : this.deck0;
  }

  private prefetchNextDeck() {
    if (!this.crossfadeSec || this.repeat === "one" || this.crossfadeBusy) return;
    const nextIdx = this.resolveNextIndex();
    if (nextIdx == null || nextIdx === this.index) return;
    const nextTr = this.queue[nextIdx];
    if (!nextTr) return;
    const out = this.activeAudio();
    const d = out.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const remain = d - out.currentTime;
    // Warm the next deck a bit before the fade window.
    if (remain > this.crossfadeSec + 10 || remain < 0.2) return;
    const path = nextTr.rel_path;
    const inEl = this.inactiveDeck();
    if (this.prefetchedRelPath === path && this.audioReadyEnough(inEl)) return;
    if (this.prefetchedRelPath !== path) {
      this.prefetchedRelPath = path;
      inEl.src = mediaUrl(path);
      inEl.load();
    }
  }

  private abortCrossfade() {
    this.crossfadeGen += 1;
    window.clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = 0;
    const wasBusy = this.crossfadeBusy;
    this.crossfadeBusy = false;
    this.crossfadeOutIx = null;
    this.crossfadeInIx = null;
    this.crossfadeNextIdx = null;
    this.prefetchedRelPath = null;
    if (!wasBusy) return;
    this.snapSolo(this.active);
    const inactive = this.inactiveDeck();
    inactive.pause();
    inactive.removeAttribute("src");
    void inactive.load();
  }

  private finalizeCrossfade() {
    if (!this.crossfadeBusy) return;
    window.clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = 0;

    const outIx = this.crossfadeOutIx;
    const inIx = this.crossfadeInIx;
    const nextIdx = this.crossfadeNextIdx;
    this.crossfadeBusy = false;
    this.crossfadeOutIx = null;
    this.crossfadeInIx = null;
    this.crossfadeNextIdx = null;

    if (outIx == null || inIx == null || nextIdx == null) {
      this.snapSolo(this.active);
      return;
    }

    const nextTr = this.queue[nextIdx];
    const outEl = outIx === 0 ? this.deck0 : this.deck1;
    const inEl = inIx === 0 ? this.deck0 : this.deck1;

    outEl.pause();
    outEl.removeAttribute("src");
    void outEl.load();
    this.prefetchedRelPath = nextTr?.rel_path ?? null;

    this.active = inIx;
    this.snapSolo(inIx);
    if (nextTr) {
      this.index = nextIdx;
      this.duration = Number.isFinite(inEl.duration) ? inEl.duration : 0;
      this.currentTime = inEl.currentTime;
      this.playing = !inEl.paused;
      this.bumpPlayCount(nextTr);
      this.updateMediaSession(nextTr);
    }
    this.emit();
  }

  private maybeStartCrossfade() {
    if (!this.crossfadeSec || this.repeat === "one" || this.crossfadeBusy) return;
    const out = this.activeAudio();
    const d = out.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const remain = d - out.currentTime;
    if (remain > this.crossfadeSec + 0.25 || remain < 0.08) return;
    void this.startCrossfade();
  }

  private async startCrossfade() {
    if (!this.crossfadeSec || this.crossfadeBusy || this.repeat === "one") return;
    const nextIdx = this.resolveNextIndex();
    if (nextIdx == null || nextIdx === this.index) return;
    const nextTr = this.queue[nextIdx];
    if (!nextTr) return;

    this.ensureGraph();
    if (!this.ctx || !this.gain0 || !this.gain1) {
      // No Web Audio graph → skip fade (avoid mute/stuck), natural advance on ended.
      return;
    }

    const outIx = this.active;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl = outIx === 0 ? this.deck0 : this.deck1;
    const inEl = inIx === 0 ? this.deck0 : this.deck1;
    const gOut = outIx === 0 ? this.gain0 : this.gain1;
    const gIn = inIx === 0 ? this.gain0 : this.gain1;

    const d = outEl.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    let remain = d - outEl.currentTime;
    if (remain < 0.08) return;

    const token = ++this.crossfadeGen;
    this.crossfadeBusy = true;
    this.crossfadeOutIx = outIx;
    this.crossfadeInIx = inIx;
    this.crossfadeNextIdx = nextIdx;

    const path = nextTr.rel_path;
    const url = mediaUrl(path);
    if (this.prefetchedRelPath !== path || !inEl.src) {
      inEl.src = url;
      inEl.load();
      this.prefetchedRelPath = path;
    }

    try {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      if (token !== this.crossfadeGen) return;
      const ready = await this.waitForAudioReady(inEl);
      if (token !== this.crossfadeGen) return;
      if (!ready) throw new Error("incoming deck not ready");
      try {
        inEl.currentTime = 0;
      } catch {
        /* ignore seek errors before metadata */
      }
      await inEl.play();
    } catch {
      if (token !== this.crossfadeGen) return;
      this.crossfadeBusy = false;
      this.crossfadeOutIx = null;
      this.crossfadeInIx = null;
      this.crossfadeNextIdx = null;
      this.snapSolo(outIx);
      inEl.pause();
      return;
    }

    if (token !== this.crossfadeGen || !this.crossfadeBusy) return;

    // Recompute with live clock — avoid scheduling a long fade after the out deck already ended.
    remain = Math.max(0.05, outEl.duration - outEl.currentTime);
    if (!Number.isFinite(remain) || outEl.ended || remain < 0.05) {
      this.finalizeCrossfade();
      return;
    }
    const fadeLen = Math.min(this.crossfadeSec, remain);

    const now = this.ctx.currentTime;
    gOut.gain.cancelScheduledValues(now);
    gIn.gain.cancelScheduledValues(now);
    gOut.gain.setValueAtTime(1, now);
    gIn.gain.setValueAtTime(0, now);
    gOut.gain.linearRampToValueAtTime(0, now + fadeLen);
    gIn.gain.linearRampToValueAtTime(1, now + fadeLen);

    this.crossfadeTimer = window.setTimeout(() => {
      if (token !== this.crossfadeGen) return;
      this.finalizeCrossfade();
    }, fadeLen * 1000 + 40);
  }

  private async loadCurrent(autoplay: boolean) {
    const track = this.current;
    if (!track) return;
    this.ensureGraph();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    this.snapSolo(this.active);
    const audio = this.activeAudio();
    audio.loop = this.repeat === "one";
    audio.src = mediaUrl(track.rel_path);
    this.updateMediaSession(track);
    this.bumpPlayCount(track);
    if (autoplay) {
      try {
        await audio.play();
      } catch {
        /* autoplay may be blocked */
      }
    }
    this.emit();
  }

  private async onEnded() {
    if (this.repeat === "one") return;
    if (this.index < this.queue.length - 1 || this.repeat === "all") {
      await this.next();
    } else {
      this.playing = false;
      this.emit();
    }
  }

  private shuffled(list: Track[]) {
    return buildSmartRandomQueue(list, {
      recentRelPaths: new Set(loadUserPrefs().recentRelPaths),
    });
  }

  private prefetchQueueCovers() {
    for (const t of this.queue.slice(this.index + 1, this.index + 6)) {
      if (t.album_id == null) continue;
      const img = new Image();
      img.src = `/api/v1/covers/album/${t.album_id}`;
    }
  }

  private updateMediaSession(track: Track) {
    if (!("mediaSession" in navigator)) return;
    const artwork =
      track.album_id != null
        ? [
            {
              src: `/api/v1/covers/album/${track.album_id}`,
              sizes: "512x512",
              type: "image/jpeg",
            },
          ]
        : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist_name,
      album: track.album_name,
      artwork,
    });
    navigator.mediaSession.setActionHandler("play", () => void this.activeAudio().play());
    navigator.mediaSession.setActionHandler("pause", () => this.activeAudio().pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => void this.prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => void this.next());
    try {
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (d.seekTime != null) this.seek(d.seekTime);
      });
    } catch {
      /* unsupported */
    }
    this.prefetchQueueCovers();
  }
}

export const player = new PlayerController();

export function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
