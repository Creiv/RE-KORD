import { getSelectedAccountId } from "./account";
import { markNeedsTranscode, mediaUrl } from "./config";
import { ApiError, api, coverUrlFor, type Track } from "./api";
import {
  constantLevel,
  createLeaseCounter,
  createLeaseSwitch,
  elementVolume,
  levelAt,
  quantizeVolume,
  rampActive,
  retargetLevel,
  type LeaseSwitch,
  type LevelRamp,
} from "./audioLevels";
import { platformCaps } from "./platformCaps";
import { touchListeningActivity } from "./achievements";
import { t } from "./i18n.svelte";
import {
  clearMediaSessionPosition,
  registerMediaSessionActions,
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
  setMediaSessionPosition,
  type MediaSessionBridge,
} from "./mediaSession";
import {
  computeQueueInsertIndex,
  insertTracksInQueue,
} from "./queueInsert";
import {
  buildRadioFromSeed,
  buildShuffleQueueFromSeed,
  buildSmartRandomQueue,
  CARD_QUEUE_CAP,
  shuffleTailFromCurrent,
} from "./smartShuffle";
import { PlaybackGuards } from "./playbackGuards";
import { PlaybackWatch } from "./playbackWatch";
import { nativeLog, pushNativeIntent } from "./nativeMedia";
import {
  countsTowardStats,
  isExternalTrack,
  isLiveTrack,
  libraryQueueForSync,
} from "./externalItems";
import { toasts } from "./toasts.svelte";
import {
  getPlayCountsMap,
  getRecentRelPaths,
  loadUserPrefs,
  patchUserPrefs,
  playCountIn,
  type CrossfadeSec,
} from "./userPrefs";

export type RepeatMode = "off" | "all" | "one";

/**
 * Where audio goes while it is not played locally (e.g. a Cast receiver).
 * Installed with `player.setRemoteOutput(output)`: from then on the player
 * keeps managing the queue and its state, but never starts local audio —
 * track loads and play/pause/seek are handed to this object, and the remote
 * reports back through `reportRemoteState` / `notifyRemoteEnded`.
 */
export type RemoteOutput = {
  /** Current track changed (or output just installed): play it from `startTime`. */
  loadTrack(track: Track, startTime: number, autoplay: boolean): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
};

type Listener = () => void;
type DeckIx = 0 | 1;

const SLEEP_FADE_MS = 30_000;
/**
 * How often element volumes are resampled while a fade runs without Web
 * Audio, and the grid they snap to. On WebKitGTK every `volume` write is a
 * PulseAudio/PipeWire stream-volume change (and the sound server echoes it
 * back as `volumechange`): 25 writes a second per deck during a crossfade
 * kept the sound server, the mixer applets and the shell busy — the whole
 * desktop stuttered at each track change. There the level moves 4 times a
 * second in 5% steps, which is still a smooth fade to the ear.
 */
const LEVEL_TICK_MS = platformCaps.webkitGtk ? 250 : 50;
const VOLUME_STEP = platformCaps.webkitGtk ? 0.05 : 0.02;
/** Longest a context resume may hold a play (WebKitGTK can leave it pending). */
const GRAPH_RESUME_TIMEOUT_MS = 1500;
/** Grace beyond the fade before the watchdog settles a stuck crossfade. */
const CROSSFADE_WATCHDOG_EXTRA_MS = 5000;
/**
 * Always-on listening session: queue + currentIndex (not volume/view), per
 * account (`<prefix>.<accountId>`). The un-suffixed keys are what older
 * builds wrote for whichever account was bound; read once, then dropped.
 */
const SESSION_QUEUE_KEY = "rekord.next.sessionQueue";
const SESSION_QUEUE_PERSIST_MS = 300;
/** Playback position, kept apart so a timeupdate never rewrites the queue. */
const SESSION_POSITION_KEY = "rekord.next.sessionPosition";
const SESSION_POSITION_PERSIST_MS = 5000;
/** Below this a restored position is not worth a seek. */
const RESTORE_POSITION_MIN_SEC = 3;
/** Consecutive tracks that failed to load before playback gives up. */
const MAX_CONSECUTIVE_TRACK_ERRORS = 3;
/** Health probe deciding "file broken" vs "hub gone" after a media error. */
const MEDIA_ERROR_PROBE_MS = 4000;
/** Hub-synced cursor (index + position) while playing: at most this often. */
const CURSOR_SYNC_MIN_MS = 60_000;
/**
 * Gapless warm-up window when crossfade is off (seconds before the end). Wide
 * enough for a slow link (tunnel, mobile data) to have the next track buffered:
 * with the phone's screen off a cold request at the boundary is where it stalled.
 */
const GAPLESS_PREFETCH_SEC = 20;
/** Extra warm-up before a crossfade's window. */
const CROSSFADE_PREFETCH_LEAD_SEC = 15;
/** Coarse stall check while the player means to play (see PlaybackWatch). */
const WATCH_TICK_MS = 5000;
/** Reconnects of the same track after network errors, in a short span. */
const MAX_NETWORK_RELOADS = 3;
const NETWORK_RELOAD_WINDOW_MS = 60_000;
/** A heartbeat saying "other audio" holds the watch this long (beats are 10 s apart). */
const OTHER_AUDIO_HOLD_MS = 15_000;
/** The OS extrapolates position between updates; this only corrects drift. */
const MEDIA_POSITION_REFRESH_MS = 5000;
/**
 * How long the analyser graph outlives its last lease. A visualizer drops its
 * lease on every pause and takes it again on play: tearing the graph down in
 * between meant a new <audio> element and a new MediaElementSource on every
 * play/pause, which on WebKitGTK re-plumbs the GStreamer pipeline on the main
 * thread (the freezes on play/pause). Within this window the graph just stays.
 */
const GRAPH_IDLE_GRACE_MS = 45_000;

type PersistedSessionQueue = {
  version: 1;
  tracks: Track[];
  currentIndex: number;
  /** When this queue was last changed (ms); decides local vs hub on restore. */
  updatedAt?: number;
};

/** Queue state handed to / taken from the hub user-state (`settings.queue`). */
export type QueueSnapshot = {
  relPaths: string[];
  index: number;
  /** Track the position belongs to (guards a stale cursor). */
  relPath: string | null;
  /** Seconds into `relPath`. */
  time: number;
  /** When the queue or cursor last changed (ms since epoch). */
  updatedAt: number;
};

/** What changed since the last sync: the list (heavy) and/or the cursor (light). */
export type QueueSyncChange = {
  list: boolean;
  cursor: boolean;
  snapshot: QueueSnapshot;
};

function accountSuffix(accountId: string | null | undefined): string {
  return (accountId || "").trim() || "default";
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Dropping the analyser graph means swapping in fresh `<audio>` decks (a
 * media element stays bound to its MediaElementSource forever). iOS / iPadOS
 * WebKit unlocks playback per element on a user gesture, so a fresh deck might
 * refuse to auto-advance there: on those devices the graph stays engaged until
 * reload instead.
 */
function deckRebuildSafe(): boolean {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return false;
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

let volumeWorks: boolean | null = null;

/**
 * Whether `HTMLMediaElement.volume` really changes the level. iOS / iPadOS
 * ignore it (it always reads back 1): there fades need the Web Audio graph.
 */
function elementVolumeWorks(): boolean {
  if (volumeWorks != null) return volumeWorks;
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    volumeWorks = Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    volumeWorks = false;
  }
  return volumeWorks;
}

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

function tracksFromRelPaths(relPaths: unknown[]): Track[] {
  return relPaths
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

function parsePersistedSessionQueue(raw: string | null): PersistedSessionQueue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionQueue> & {
      relPaths?: string[];
    };
    let tracks: Track[] = [];
    if (Array.isArray(parsed.tracks)) {
      tracks = parsed.tracks.filter(isTrackLike);
    } else if (Array.isArray(parsed.relPaths)) {
      // Older shape: only paths — restore needs catalog remap.
      tracks = tracksFromRelPaths(parsed.relPaths);
    }
    if (!tracks.length) return null;
    const currentIndex =
      typeof parsed.currentIndex === "number" && Number.isFinite(parsed.currentIndex)
        ? Math.max(0, Math.floor(parsed.currentIndex))
        : 0;
    const updatedAt = Number(parsed.updatedAt);
    return {
      version: 1,
      tracks,
      currentIndex,
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * This account's saved queue. The pre-account global key is adopted once by
 * the account bound when it is first read (it was that account's queue), and
 * removed so no other account can ever restore it.
 */
function loadPersistedSessionQueue(accountId: string): PersistedSessionQueue | null {
  try {
    const own = localStorage.getItem(`${SESSION_QUEUE_KEY}.${accountId}`);
    if (own) return parsePersistedSessionQueue(own);
    const legacy = localStorage.getItem(SESSION_QUEUE_KEY);
    if (!legacy) return null;
    localStorage.removeItem(SESSION_QUEUE_KEY);
    if (accountId !== accountSuffix(getSelectedAccountId())) return null;
    localStorage.setItem(`${SESSION_QUEUE_KEY}.${accountId}`, legacy);
    const pos = localStorage.getItem(SESSION_POSITION_KEY);
    if (pos) {
      localStorage.setItem(`${SESSION_POSITION_KEY}.${accountId}`, pos);
      localStorage.removeItem(SESSION_POSITION_KEY);
    }
    return parsePersistedSessionQueue(legacy);
  } catch {
    return null;
  }
}

/** Snapshot fields worth keeping; lyrics can be kilobytes per track. */
function slimTrack(track: Track): Track {
  const { lyrics: _lyrics, ...rest } = track;
  return rest;
}

/**
 * Best effort: a full localStorage (quota) or a disabled one (private mode,
 * blocked site data) must never break playback. Falls back to paths only,
 * which the restore remaps through the catalog.
 */
function savePersistedSessionQueue(
  accountId: string,
  queue: Track[],
  currentIndex: number,
  updatedAt: number,
) {
  const key = `${SESSION_QUEUE_KEY}.${accountId}`;
  try {
    if (!queue.length) {
      localStorage.removeItem(key);
      return;
    }
    const index = Math.max(0, Math.min(currentIndex, queue.length - 1));
    const payload: PersistedSessionQueue = {
      version: 1,
      tracks: queue.map(slimTrack),
      currentIndex: index,
      updatedAt,
    };
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      localStorage.setItem(
        key,
        JSON.stringify({ relPaths: queue.map((t) => t.rel_path), currentIndex: index, updatedAt }),
      );
    }
  } catch {
    /* storage full or unavailable: the session simply is not restored */
  }
}

type PersistedPosition = { relPath: string; time: number; updatedAt?: number };

function loadPersistedPosition(accountId: string): PersistedPosition | null {
  try {
    const raw = localStorage.getItem(`${SESSION_POSITION_KEY}.${accountId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedPosition>;
    if (typeof p.relPath !== "string" || !p.relPath) return null;
    const time = Number(p.time);
    if (!Number.isFinite(time) || time < 0) return null;
    const updatedAt = Number(p.updatedAt);
    return { relPath: p.relPath, time, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
  } catch {
    return null;
  }
}

function savePersistedPosition(accountId: string, pos: PersistedPosition | null) {
  const key = `${SESSION_POSITION_KEY}.${accountId}`;
  try {
    if (!pos) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(pos));
  } catch {
    /* ignore: position restore is a nicety */
  }
}

class PlayerController {
  private deck0: HTMLAudioElement;
  private deck1: HTMLAudioElement;
  /** Aborting one detaches every listener of that deck (it is being replaced). */
  private deckBindings: [AbortController | null, AbortController | null] = [null, null];
  private active: DeckIx = 0;
  /**
   * Web Audio graph, only while something needs the analyser (see
   * `acquireAnalyser`). Routing the decks through it is expensive on some
   * engines (WebKitGTK re-renders every decoded frame through a second
   * pipeline), so plain playback, crossfades and fades never need it.
   */
  private ctx: AudioContext | null = null;
  /** Per-deck crossfade level while the deck is wired (element volume stays 1). */
  private gains: [GainNode | null, GainNode | null] = [null, null];
  /** Non-null = that deck element plays through the graph (irreversible for it). */
  private sources: [MediaElementAudioSourceNode | null, MediaElementAudioSourceNode | null] = [
    null,
    null,
  ];
  /** Master (sleep fade) level for wired decks. */
  private outputGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserLeases = createLeaseCounter(
    () => this.engageGraph(),
    () => this.onAnalyserIdle(),
  );
  /** Pending teardown of an idle graph (see GRAPH_IDLE_GRACE_MS); 0 = none. */
  private graphIdleTimer = 0;
  /** Deferred hub cursor sync after a pause (kept off the pause handler). */
  private pauseSyncTimer = 0;
  /** Crossfade level of each deck: 1 = heard, 0 = silent. */
  private deckLevels: [LevelRamp, LevelRamp] = [constantLevel(1), constantLevel(0)];
  /** Whole-output level (sleep-timer fade). */
  private masterLevel: LevelRamp = constantLevel(1);
  /** Resamples element volumes while a ramp runs on an unwired deck. */
  private levelTicker = 0;
  /** Async deck work holding element references across awaits (no deck swap meanwhile). */
  private deckOpsInFlight = 0;
  /** Permanent graph lease where element volume is ignored (iOS): fades need GainNodes there. */
  private fadeLease: (() => void) | null = null;
  private crossfadeBusy = false;
  private crossfadeTimer = 0;
  private crossfadeGen = 0;
  private crossfadeOutIx: DeckIx | null = null;
  private crossfadeInIx: DeckIx | null = null;
  private crossfadeNextIdx: number | null = null;
  /** Settles a crossfade that did not complete on its own (see rescueCrossfade). */
  private crossfadeWatchdog = 0;
  /**
   * The transition whose incoming deck refused to play: no new crossfade is
   * attempted for it (each attempt reloads the deck — a new GStreamer
   * pipeline and a new hub request — on every timeupdate). The plain
   * end-of-track advance handles it, transcode fallback included.
   */
  private crossfadeRefused: { from: string; to: string } | null = null;
  /** Last volume this player wrote on each element (reads may come back quantized). */
  private writtenVolume = new WeakMap<HTMLAudioElement, number>();
  /** Pending echo checks per element (see onDeckVolumeEcho). */
  private volumeEchoTimers = new WeakMap<HTMLAudioElement, number>();
  private prefetchedRelPath: string | null = null;
  /** Cancels in-flight dual-deck loads when the user skips again. */
  private loadGen = 0;
  private listeners = new Set<Listener>();
  /** Progress-only listeners (timeupdate) — must not drive full app re-renders. */
  private progressListeners = new Set<Listener>();
  /** Play/pause only — cheaper than a full state emit (lists don't care). */
  private playStateListeners = new Set<Listener>();
  /** Latest requested seek, applied once per animation frame. */
  private pendingSeek: number | null = null;
  private seekFrame = 0;
  private lastPositionSaveAt = 0;
  /** Position to apply once the restored track has metadata. */
  private restorePosition: PersistedPosition | null = null;

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
  private sleepFadeTimer = 0;
  private excludedRelPaths = new Set<string>();
  private excludedAlbumIds = new Set<number>();
  /** Paths inserted via "add to queue" — stay ahead of auto-fill inserts. */
  private manualQueuedPaths = new Set<string>();
  /** Legacy half-listen: count once past 50% (reset if seek < 10%). */
  private halfListenCounted = false;
  private halfListenPath: string | null = null;
  private persistQueueTimer = 0;
  /** Last saved list signature / index (see `flushPersistQueue`). */
  private lastQueueListSig = "";
  private lastPersistIndex = -1;
  private lastPersistLen = -1;
  private lastPersistFirst = "";
  private lastPersistCurrent = "";
  /** A mutation the cheap pre-check cannot see (reorder in the middle). */
  private queueDirty = false;
  private queueUpdatedAt = 0;
  private lastCursorSyncAt = 0;
  private queueSync: ((change: QueueSyncChange) => void) | null = null;
  /** Account the saved queue / position belong to. */
  private boundAccount = accountSuffix(getSelectedAccountId());
  /** While true nothing is persisted (account switch in progress). */
  private persistSuspended = false;
  private restoringSession = false;
  private sessionRestored = false;
  /** Tracks in a row that failed to load (missing / unreadable files). */
  private consecutiveErrors = 0;
  /** Set while the hub is unreachable: what to resume once it is back. */
  private outage: { relPath: string; time: number; play: boolean } | null = null;
  private outageListener: (() => void) | null = null;
  private mediaErrorBusy = false;
  /** Stall supervision of the active deck (see playbackWatch.ts). */
  private watch = new PlaybackWatch();
  private watchTimer = 0;
  /** A `play()` refused in the background: the watch tries again. */
  private playRetry = false;
  /** Loads in flight that end in `play()`: the player already means to play. */
  private autoplayLoads = 0;
  /**
   * Bumped by every pause (user, notification, headset, car, sleep timer). A load
   * or reconnect started before it must not call `play()` afterwards: a pause
   * always wins over an automatic reload.
   */
  private pauseGen = 0;
  /** `pauseGen` when the latest autoplay load started (see `autoplayPending`). */
  private autoplayPauseGen = 0;
  /** Reason carried by the active deck's next `pause` event (null: not asked for). */
  private expectedPause: string | null = null;
  /**
   * Why playback is paused, for the Android shell: `external` (the engine paused
   * on its own: another app took the audio) may be resumed by the shell.
   */
  private pauseReason = "";
  /** Until when the Android shell says another app (or a call) has the audio. */
  private otherAudioUntil = 0;
  /** Network-error reconnects of the current track (see onTrackFailed). */
  private networkReloads = { relPath: "", count: 0, at: 0 };
  /** Hold / seek lock / crossfade override laid over the player (Plectr). */
  private guards = new PlaybackGuards();
  /** Set when a held track reached its end (cleared by the next load / play). */
  private heldEndedFlag = false;
  private heldEndListeners = new Set<(track: Track | null) => void>();
  /** The sticky "playback stopped" notice, dismissed once something plays. */
  private errorNoticeId: number | null = null;
  private lastMediaPositionAt = 0;
  /**
   * Favourites live in the session store, which already imports the player;
   * it hands the toggle over here so the OS "like" button can reach it without
   * an import cycle.
   */
  private favoriteToggle: (() => void) | null = null;
  /** Remote playback target (Cast); null = local decks. */
  private remote: RemoteOutput | null = null;

  constructor() {
    const prefs = loadUserPrefs();
    this.crossfadeSec = prefs.crossfadeSec;
    this.excludedRelPaths = new Set(prefs.excludedRelPaths);
    this.excludedAlbumIds = new Set(prefs.excludedAlbumIds);

    this.deck0 = this.createDeck(0);
    this.deck1 = this.createDeck(1);
    this.applyLevels();

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        this.flushPersistQueue();
        this.persistPosition(true);
      });
      // Registered once: the OS keeps the same handlers across track changes.
      registerMediaSessionActions(() => this.mediaBridge());
      // Stall checks that do not depend on the page's own (throttled) timers:
      // the connection is back, the Android shell's heartbeat, a network change.
      window.addEventListener("online", () => this.checkPlayback("online", true));
      window.addEventListener("rekord:playback-watchdog", (event) => {
        const detail = (event as CustomEvent<{ otherAudio?: boolean }>).detail;
        // A call or another app has the audio: no play() / reload until it is over
        // (the shell resumes an interrupted track itself, see RekordInterruption.kt).
        this.otherAudioUntil = detail?.otherAudio ? Date.now() + OTHER_AUDIO_HOLD_MS : 0;
        this.checkPlayback("heartbeat");
      });
      window.addEventListener("rekord:network", (event) => {
        const detail = (event as CustomEvent<{ available?: boolean; transport?: string }>).detail;
        if (!detail?.available) return;
        this.checkPlayback(`network ${detail.transport ?? ""}`.trim(), true);
      });
    }
  }

  /** Lets the session store wire "like" from the lock screen to favourites. */
  setFavoriteToggle(fn: (() => void) | null) {
    this.favoriteToggle = fn;
  }

  private mediaBridge(): MediaSessionBridge {
    return {
      play: () => {
        if (!this.playing) void this.toggle();
      },
      pause: () => {
        // From the notification, the headset or the car: a user pause even when
        // the track is already silent (interrupted, waiting for the hub), so the
        // shell never resumes it on its own.
        this.pauseReason = "user";
        this.playRetry = false;
        if (this.outage) this.outage.play = false;
        // Also while a reconnect is loading (silent, but about to play).
        if (this.playing || this.wantsPlay()) this.pause();
        else this.syncNativeIntent();
      },
      next: () => void this.next(),
      prev: () => void this.prev(),
      seek: (seconds) => this.seek(seconds),
      seekBy: (delta) => {
        const at = this.pendingSeek ?? this.activeAudio().currentTime;
        const max = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY;
        this.seek(Math.min(max, Math.max(0, at + delta)));
      },
      toggleShuffle: () => this.toggleShuffle(),
      cycleRepeat: () => this.cycleRepeat(),
      toggleFavorite: () => this.favoriteToggle?.(),
      toggleExclude: () => {
        const track = this.current;
        if (track) this.toggleExcludeTrack(track);
      },
    };
  }

  private createDeck(ix: DeckIx): HTMLAudioElement {
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    const binding = new AbortController();
    this.deckBindings[ix] = binding;
    this.bindDeck(audio, ix, binding.signal);
    return audio;
  }

  private deckEl(ix: DeckIx): HTMLAudioElement {
    return ix === 0 ? this.deck0 : this.deck1;
  }

  private bindDeck(audio: HTMLAudioElement, ix: DeckIx, signal: AbortSignal) {
    const on = (type: string, fn: () => void) =>
      audio.addEventListener(type, fn, { signal });
    on("timeupdate", () => {
      // Backstop for the level ticker: media events keep coming when timers
      // are throttled (hidden window, phone in a pocket).
      if (this.levelTicker) this.applyElementLevels();
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (this.crossfadeBusy) {
        // Keep UI moving during fade (outgoing until swap).
        if (this.crossfadeOutIx === ix) {
          this.currentTime = audio.currentTime;
          this.emitProgress();
        }
        return;
      }
      if (ix !== this.active) return;
      // A seek is queued for the next frame: the element still reports the
      // old position and would make the timeline jump back for one tick.
      if (this.pendingSeek != null) return;
      // The track is changing: this deck still plays the previous item while
      // the new one buffers on the other deck. Its position is not the new
      // track's (a podcast's 5:11 would be saved and synced for a 3:27 song,
      // or recorded as an episode's resume point).
      const cur = this.current;
      if (!cur || audio.getAttribute("src") !== mediaUrl(cur.rel_path)) return;
      // A reload waiting for its metadata reports 0 until the restore seek: the
      // timeline (and the notification) keep the position it will resume at.
      if (this.restorePosition && this.restorePosition.relPath === this.current?.rel_path) return;
      this.currentTime = audio.currentTime;
      if (this.watchTimer) this.watch.observe(Date.now(), audio.currentTime);
      this.prefetchNextDeck();
      this.maybeStartCrossfade();
      this.maybeCountHalfListen();
      this.syncMediaPosition();
      this.persistPosition();
      this.emitProgress();
    });
    on("volumechange", () => this.onDeckVolumeEcho(audio));
    on("loadedmetadata", () => {
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (ix !== this.active) return;
      this.applyRestorePosition(audio);
    });
    on("durationchange", () => {
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (this.crossfadeBusy && this.crossfadeInIx === ix) {
        this.duration = this.deckDuration(audio);
        this.emitProgress();
        return;
      }
      if (ix !== this.active) return;
      this.duration = this.deckDuration(audio);
      this.syncMediaPosition(true);
      this.emitProgress();
    });
    on("play", () => {
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (this.crossfadeBusy) {
        if (this.crossfadeInIx === ix || this.crossfadeOutIx === ix) {
          this.expectedPause = null;
          this.pauseReason = "";
          this.playing = true;
          this.syncMediaPlaybackState();
          this.emit();
        }
        return;
      }
      if (ix !== this.active) return;
      this.expectedPause = null;
      this.pauseReason = "";
      if (this.playing) return;
      this.playing = true;
      this.syncMediaPlaybackState();
      this.emitPlayState();
    });
    on("pause", () => {
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (ix !== this.active || this.crossfadeBusy) return;
      // `ended` also pauses: the advance that follows is the real change.
      if (audio.ended) return;
      if (!this.playing) return;
      // Not asked for by the player: the engine paused it (audio focus taken by a
      // call, a video, another music app). The Android shell may resume it.
      const reason = this.expectedPause ?? "external";
      this.expectedPause = null;
      this.pauseReason = reason;
      if (reason === "external") nativeLog("paused by the system (another app took the audio)");
      this.playing = false;
      this.syncMediaPlaybackState();
      // Position saved now; the hub cursor sync (JSON of the whole synced
      // settings, queue included, into localStorage + a push) waits until
      // the paused state has been painted.
      this.persistPosition(true, true);
      this.emitPlayState();
    });
    on("ended", () => {
      // Decks are silent while a remote output plays: their events are stale.
      if (this.remote) return;
      if (this.crossfadeBusy) {
        if (ix === this.crossfadeOutIx) this.finalizeCrossfade();
        return;
      }
      if (ix !== this.active) return;
      void this.onEnded();
    });
    on("playing", () => {
      if (ix === this.active) this.heldEndedFlag = false;
      if (this.remote) return;
      if (ix !== this.active && !(this.crossfadeBusy && this.crossfadeInIx === ix)) return;
      // A track really plays: the failure streak and any outage are over.
      this.consecutiveErrors = 0;
      this.outage = null;
      if (this.playRetry) {
        this.playRetry = false;
        nativeLog("playing again after a refused play()");
        this.syncNativeIntent();
      }
      if (this.errorNoticeId != null) {
        toasts.dismiss(this.errorNoticeId);
        this.errorNoticeId = null;
      }
    });
    // Diagnostics only: the watch decides from the clock whether it is a stall.
    for (const type of ["waiting", "stalled"]) {
      on(type, () => {
        if (this.remote || ix !== this.active || !this.playing) return;
        // Every track start buffers for a moment: only mid-track waits are news.
        if (audio.currentTime < 1) return;
        nativeLog(`deck ${type} at ${Math.round(audio.currentTime)}s (ready ${audio.readyState}, network ${audio.networkState})`);
        this.checkPlayback(type);
      });
    }
    on("error", () => {
      if (this.remote) return;
      const src = audio.getAttribute("src");
      if (!src) return;
      const cur = this.current;
      if (ix !== this.active || !cur || src !== mediaUrl(cur.rel_path)) {
        // A warm-up of the next track failed: forget it, the real load retries.
        if (ix !== this.active && this.prefetchedRelPath && src === mediaUrl(this.prefetchedRelPath)) {
          this.prefetchedRelPath = null;
        }
        return;
      }
      // The incoming deck of a load is handled by `loadCurrentDecks` itself.
      // `wantsPlay`, not `playing`: a reconnect still loading has not played yet,
      // and its failure must not turn "waiting for the hub" into "paused".
      void this.onTrackFailed(cur, this.wantsPlay(), this.resumePoint(), audio.error?.code);
    });
  }

  /**
   * The current track would not load or broke off. Either the hub is gone
   * (then nothing is skipped: the session probes the hub and
   * `resumeAfterOutage` picks up where it stopped) or the file is missing /
   * unreadable (then it is skipped, like legacy; after
   * MAX_CONSECUTIVE_TRACK_ERRORS failures in a row playback stops with a
   * notice that stays until dismissed or until something plays).
   */
  private async onTrackFailed(track: Track, wantPlay: boolean, at = 0, errorCode?: number) {
    if (this.mediaErrorBusy || this.remote) return;
    this.mediaErrorBusy = true;
    const gen = this.loadGen;
    let skipTo: number | null = null;
    let reconnectAt: number | null = null;
    let transcode = false;
    try {
      // Asked first: a refused or dropped connection also surfaces as "format
      // not supported" (nothing was read to know the format), and must not
      // send the track to the transcoder for the rest of the session.
      const reachable = await this.hubReachable();
      // The user moved on meanwhile: that load decides for itself.
      if (gen !== this.loadGen || this.current?.rel_path !== track.rel_path) return;
      if (!reachable) {
        nativeLog(`media error ${errorCode ?? "?"} at ${Math.round(at)}s, hub unreachable: waiting for it`);
        this.outage = { relPath: track.rel_path, time: Math.max(0, at), play: wantPlay };
        // The previous track may still be draining its buffer on the other
        // deck: the user asked for this one, so silence until it can play.
        this.expectPause("outage");
        this.deck0.pause();
        this.deck1.pause();
        this.playing = false;
        this.syncMediaPlaybackState();
        this.emitPlayState();
        this.outageListener?.();
        return;
      }
      // "Format not supported" (e.g. WMA/AIFF/ALAC in WebKitGTK or Chromium): try
      // the hub's transcoded stream once before calling the file broken.
      if (
        errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED &&
        markNeedsTranscode(track.rel_path)
      ) {
        transcode = true;
        return;
      }
      // The connection broke (network switch, a tunnel hiccup) but the hub
      // answers: the file is fine, reconnect where it stopped instead of skipping.
      if (errorCode === MediaError.MEDIA_ERR_NETWORK && this.allowNetworkReload(track.rel_path)) {
        nativeLog(`network error at ${Math.round(at)}s, hub reachable: reconnecting`);
        // Started in `finally`, once this handler no longer counts as busy.
        reconnectAt = isLiveTrack(track) ? 0 : Math.max(0, at);
        return;
      }
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_TRACK_ERRORS) {
        this.consecutiveErrors = 0;
        nativeLog(`${MAX_CONSECUTIVE_TRACK_ERRORS} tracks in a row failed: stopping`);
        this.expectPause("error");
        this.playRetry = false;
        this.deck0.pause();
        this.deck1.pause();
        this.playing = false;
        this.syncMediaPlaybackState();
        this.emit();
        // One notice for the whole streak: the "skipped" toast it replaces goes.
        toasts.dismissKey("player-track-skipped");
        this.errorNoticeId = toasts.error(t("core.player.tooManyErrors"), {
          key: "player-too-many-errors",
          duration: null,
        });
        return;
      }
      toasts.error(t("core.player.trackSkipped", { title: track.title }), {
        key: "player-track-skipped",
      });
      skipTo = this.nextIndexAfterFailure();
      if (skipTo == null) {
        this.playing = false;
        this.syncMediaPlaybackState();
        this.emit();
      }
    } finally {
      this.mediaErrorBusy = false;
      if (reconnectAt != null) void this.reloadCurrentAt(reconnectAt, wantPlay);
      if (transcode) {
        this.cancelPendingLoad();
        this.abortCrossfade();
        void this.loadCurrent(wantPlay);
      }
    }
    if (skipTo != null) {
      this.cancelPendingLoad();
      this.abortCrossfade();
      this.index = skipTo;
      await this.loadCurrent(wantPlay);
    }
  }

  /** A few network reconnects per track and minute; past that, the old skip. */
  private allowNetworkReload(relPath: string): boolean {
    const now = Date.now();
    const r = this.networkReloads;
    if (r.relPath !== relPath || now - r.at > NETWORK_RELOAD_WINDOW_MS) {
      this.networkReloads = { relPath, count: 1, at: now };
      return true;
    }
    if (r.count >= MAX_NETWORK_RELOADS) return false;
    r.count += 1;
    r.at = now;
    return true;
  }

  /** The next `pause` event of the active deck comes from the player, for `reason`. */
  private expectPause(reason: string) {
    this.pauseReason = reason;
    if (!this.activeAudio().paused) this.expectedPause = reason;
  }

  /**
   * Where a reconnect should resume. A reload still waiting for its metadata
   * holds the position in `restorePosition` while the element (and its
   * `timeupdate`) already says 0: a second reconnect must not start over.
   */
  private resumePoint(): number {
    const cur = this.current;
    if (!cur || isLiveTrack(cur)) return 0;
    const pending = this.restorePosition;
    return pending && pending.relPath === cur.rel_path ? pending.time : this.currentTime;
  }

  /** Does the player mean to play (even with nothing sounding yet)? */
  private wantsPlay(): boolean {
    if (this.remote) return this.playing;
    return this.playing || this.playRetry || this.autoplayPending() || this.outage?.play === true;
  }

  /** A load that will end in `play()` is in flight, and no pause came since. */
  private autoplayPending(): boolean {
    return this.autoplayLoads > 0 && this.pauseGen === this.autoplayPauseGen;
  }

  /**
   * A pause arrived while a load or reconnect of `gen`'s era was in flight:
   * it must not play, and the state says paused even if the deck's own `pause`
   * event went to a deck that is no longer the active one.
   */
  private pausedSince(pauseGen: number): boolean {
    if (this.pauseGen === pauseGen) return false;
    if (this.playing) {
      this.playing = false;
      this.syncMediaPlaybackState();
      this.emitPlayState();
    }
    return true;
  }

  /**
   * Tell the Android shell what the player means to do (it keeps CPU and
   * network awake for it) and run the stall check while it means to play.
   */
  private syncNativeIntent() {
    const wants = this.wantsPlay();
    pushNativeIntent(wants, this.playing ? "" : this.pauseReason);
    if (typeof window === "undefined") return;
    // The stall check has nothing to do while casting or waiting for the hub
    // (`checkPlayback` returns at once): no timer for those, possibly hours.
    const watch = wants && !this.remote && !this.outage;
    if (watch && !this.watchTimer) {
      this.watch.reset(Date.now());
      this.watchTimer = window.setInterval(() => this.checkPlayback("timer"), WATCH_TICK_MS);
    } else if (!watch && this.watchTimer) {
      window.clearInterval(this.watchTimer);
      this.watchTimer = 0;
      this.watch.reset(Date.now());
    }
  }

  /**
   * Is the active deck doing what the player thinks? Called from timers, media
   * events, `online` and the Android heartbeat; PlaybackWatch decides from the
   * clock, so a late call is harmless. `urgent`: the network just came back.
   */
  private checkPlayback(source: string, urgent = false) {
    if (this.remote || !this.current) return;
    if (this.outage || Date.now() < this.otherAudioUntil) {
      // Hub unreachable: the session probes it (the heartbeat speeds that up) and
      // `resumeAfterOutage` reloads. A reload from here would only fail again.
      // Another app's audio: a play() would take the focus back from it.
      this.watch.reset(Date.now());
      return;
    }
    const a = this.activeAudio();
    const action = this.watch.check(
      Date.now(),
      {
        wantsPlay: this.wantsPlay(),
        busy:
          this.deckOpsInFlight > 0 ||
          this.crossfadeBusy ||
          this.mediaErrorBusy ||
          this.pendingSeek != null ||
          a.seeking,
        paused: a.paused,
        ended: a.ended,
        currentTime: a.currentTime,
        error: a.error != null,
      },
      urgent,
    );
    if (action.kind === "none") return;
    const stuck = Math.round(action.stuckMs / 1000);
    switch (action.kind) {
      case "play":
        nativeLog(`watch (${source}): silent for ${stuck}s, play() attempt ${action.attempt}`);
        void this.retryPlay(a);
        return;
      case "reload": {
        const at = this.resumePoint();
        const err = a.error ? `, error ${a.error.code}` : "";
        nativeLog(`watch (${source}): no progress for ${stuck}s${err}, reconnecting at ${Math.round(at)}s (attempt ${action.attempt})`);
        void this.reloadCurrentAt(at, true);
        return;
      }
      case "advance":
        nativeLog(`watch (${source}): track ended ${stuck}s ago without advancing, moving on`);
        void this.onEnded();
        return;
      case "giveUp":
        nativeLog(`watch (${source}): nothing played for ${stuck}s despite retries, giving up`);
        this.playRetry = false;
        this.pauseLocalDecks();
        this.pauseReason = "error";
        this.playing = false;
        this.syncMediaPlaybackState();
        this.emitPlayState();
        toasts.error(t("core.player.playFailed"), { key: "player-play-failed" });
        return;
    }
  }

  private async retryPlay(a: HTMLAudioElement) {
    const gen = this.loadGen;
    const pauseGen = this.pauseGen;
    try {
      const resume = this.resumeGraphForPlay();
      if (resume) await resume;
      // Anything may have happened meanwhile: a skip, a pause, a Cast session.
      if (
        gen !== this.loadGen ||
        pauseGen !== this.pauseGen ||
        a !== this.activeAudio() ||
        this.remote ||
        !this.wantsPlay()
      ) {
        return;
      }
      await a.play();
    } catch (e) {
      nativeLog(`play() refused again: ${e instanceof DOMException ? e.name : String(e)}`);
    }
  }

  /**
   * A `play()` that was not the user's (next track, reconnect) failed. In the
   * background (screen off) the watch keeps trying; in front the user sees why.
   */
  private onAutoplayFailed(e: unknown) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "AbortError") return;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (hidden && name !== "NotSupportedError") {
      nativeLog(`play() refused in the background (${name || String(e)}): will retry`);
      this.playRetry = true;
      this.syncNativeIntent();
      // The stall clock starts now, on this deck (a new track's position).
      this.watch.observe(Date.now(), this.activeAudio().currentTime, true);
      return;
    }
    this.reportPlayFailure(e);
  }

  /** Next index when skipping a broken track (repeat-one would loop on it). */
  private nextIndexAfterFailure(): number | null {
    if (this.index < this.queue.length - 1) return this.index + 1;
    if (this.repeat !== "off" && this.queue.length > 1) return 0;
    return null;
  }

  /** Does the hub answer at all? (Any HTTP answer counts as yes.) */
  private async hubReachable(): Promise<boolean> {
    try {
      await api.health({ timeoutMs: MEDIA_ERROR_PROBE_MS });
      return true;
    } catch (e) {
      return !(e instanceof ApiError && e.offline);
    }
  }

  /** The session hears from here when playback stopped because the hub went away. */
  setOutageListener(fn: (() => void) | null) {
    this.outageListener = fn;
  }

  /** True while playback waits for the hub to come back. */
  get waitingForHub(): boolean {
    return this.outage != null;
  }

  /**
   * The hub is reachable again: reload the current track where it stopped
   * and resume if it was playing. Also covers a deck that stalled or broke
   * off without telling us. Returns whether anything was reloaded.
   */
  resumeAfterOutage(): boolean {
    if (this.remote) return false;
    const cur = this.current;
    const o = this.outage;
    if (!cur) {
      this.outage = null;
      return false;
    }
    const el = this.activeAudio();
    const broken =
      el.error != null ||
      (this.playing && el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !el.seeking);
    if (!o && !broken) return false;
    const time = o && o.relPath === cur.rel_path ? o.time : this.resumePoint();
    const play = o ? o.play : this.playing;
    nativeLog(`hub back: reloading at ${Math.round(time)}s${play ? ", playing" : ""}`);
    this.outage = null;
    void this.reloadCurrentAt(time, play);
    return true;
  }

  /** Fresh load of the current track on the active deck at `time`. */
  private async reloadCurrentAt(time: number, play: boolean) {
    const cur = this.current;
    if (!cur) return;
    this.deckOpsInFlight += 1;
    const pauseGen = this.pauseGen;
    if (play) {
      this.autoplayPauseGen = pauseGen;
      this.autoplayLoads += 1;
      this.syncNativeIntent();
    }
    try {
      const gen = ++this.loadGen;
      this.abortCrossfade();
      this.cancelPendingSeek();
      const a = this.activeAudio();
      this.prefetchedRelPath = null;
      if (!a.paused) this.expectedPause = "reload";
      a.loop = this.repeat === "one";
      this.restorePosition = time >= 1 ? { relPath: cur.rel_path, time } : null;
      this.currentTime = time;
      this.emitProgress();
      a.src = mediaUrl(cur.rel_path);
      a.load();
      if (!play) {
        this.emit();
        return;
      }
      await this.waitForAudioReady(a, 8000, this.knownDuration(cur) > 0);
      if (gen !== this.loadGen) return;
      // Paused (app, notification, car) while it loaded: stay paused.
      if (this.pausedSince(pauseGen)) {
        this.emit();
        return;
      }
      try {
        const resume = this.resumeGraphForPlay();
        if (resume) await resume;
        if (gen !== this.loadGen || this.pausedSince(pauseGen)) return;
        await a.play();
        if (gen !== this.loadGen) return;
        this.playing = true;
        this.syncMediaPlaybackState();
      } catch (e) {
        if (gen !== this.loadGen) return;
        this.playing = false;
        this.onAutoplayFailed(e);
      }
      this.emit();
    } finally {
      this.deckOpsInFlight -= 1;
      if (play) {
        this.autoplayLoads -= 1;
        this.syncNativeIntent();
      }
      this.maybeDropGraph();
    }
  }

  /** True while a remote output (Cast) plays instead of the local decks. */
  get remoteOutputActive(): boolean {
    return this.remote != null;
  }

  /**
   * Route playback to a remote output (`null` → back to local audio).
   *
   * Installing it pauses the decks and hands over the current track at the
   * current position (playing if it was playing). Removing it resumes the
   * decks at the last position the remote reported, playing if the remote was.
   * All other player APIs keep working unchanged.
   */
  setRemoteOutput(output: RemoteOutput | null): void {
    if (output === this.remote) return;
    if (output) {
      const wasPlaying = this.playing;
      const pos = this.remote ? this.currentTime : this.activeAudio().currentTime || this.currentTime;
      this.cancelPendingLoad();
      this.abortCrossfade();
      this.cancelPendingSeek();
      this.deck0.pause();
      this.deck1.pause();
      this.remote = output;
      this.playing = wasPlaying;
      this.currentTime = pos;
      this.emit();
      const cur = this.current;
      if (cur) output.loadTrack(cur, pos, wasPlaying);
      return;
    }
    const pos = this.currentTime;
    const resume = this.playing;
    this.remote = null;
    this.playing = false;
    this.syncMediaPlaybackState();
    void this.resumeLocalAt(pos, resume);
  }

  /** Back from remote: make sure the active deck holds the current track, seek, play. */
  private async resumeLocalAt(pos: number, play: boolean) {
    this.deckOpsInFlight += 1;
    try {
      await this.resumeLocalDeckAt(pos, play);
    } finally {
      this.deckOpsInFlight -= 1;
      this.maybeDropGraph();
    }
  }

  private async resumeLocalDeckAt(pos: number, play: boolean) {
    const cur = this.current;
    if (!cur) {
      this.emit();
      return;
    }
    const gen = ++this.loadGen;
    const a = this.activeAudio();
    const url = mediaUrl(cur.rel_path);
    if (a.getAttribute("src") !== url) {
      this.prefetchedRelPath = null;
      a.loop = this.repeat === "one";
      a.src = url;
      a.load();
      await this.waitForAudioReady(a, 8000, this.knownDuration(cur) > 0);
      if (gen !== this.loadGen || this.remote) return;
    }
    try {
      a.currentTime = pos;
    } catch {
      /* not seekable yet */
    }
    this.currentTime = pos;
    this.emit();
    this.emitProgress();
    if (play) await this.toggle();
  }

  /** Remote status (≈1 Hz): mirrors play state / position into the player. */
  reportRemoteState(state: { playing: boolean; currentTime: number; duration?: number }): void {
    if (!this.remote) return;
    if (state.playing !== this.playing) {
      this.playing = state.playing;
      this.syncMediaPlaybackState();
      this.emitPlayState();
    }
    if (Number.isFinite(state.currentTime)) this.currentTime = Math.max(0, state.currentTime);
    if (state.duration && state.duration > 0) this.duration = state.duration;
    // Same half-listen rule as local playback.
    const track = this.current;
    if (track && countsTowardStats(track) && this.duration > 0) {
      if (this.halfListenPath !== track.rel_path) this.resetHalfListen(track);
      if (this.halfListenCounted && this.currentTime < this.duration * 0.1) this.halfListenCounted = false;
      if (!this.halfListenCounted && this.currentTime >= this.duration * 0.5) {
        this.halfListenCounted = true;
        this.bumpPlayCount(track);
        this.emit();
      }
    }
    this.syncMediaPosition();
    this.emitProgress();
  }

  /** The remote finished the current track: advance like a local `ended`. */
  notifyRemoteEnded(): void {
    if (!this.remote) return;
    if (!this.guards.advanceOnEnd()) {
      this.finishHeldTrack();
      return;
    }
    if (this.repeat === "one") {
      void this.loadCurrent(true);
      return;
    }
    void this.onEnded();
  }

  /** State changes (track/queue/playing) — safe for full UI refresh. */
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Timeline progress only — keep subscribers lightweight (legacy playerProgressStore). */
  subscribeProgress(fn: Listener) {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  /**
   * Play/pause flips only. `subscribe` no longer fires for them: a pause does
   * not change what lists show, and re-deriving them on every toggle was the
   * main cost of pressing play.
   */
  subscribePlayState(fn: Listener) {
    this.playStateListeners.add(fn);
    return () => this.playStateListeners.delete(fn);
  }

  private emit() {
    this.schedulePersistQueue();
    for (const fn of this.listeners) fn();
    for (const fn of this.playStateListeners) fn();
  }

  private emitProgress() {
    for (const fn of this.progressListeners) fn();
  }

  private emitPlayState() {
    for (const fn of this.playStateListeners) fn();
  }

  /**
   * Throttled save of the playback position (forced on pause / pagehide).
   * `deferSync`: run the forced hub cursor sync a moment later, off the
   * current event (pause), instead of synchronously.
   */
  private persistPosition(force = false, deferSync = false) {
    if (this.restoringSession || this.restorePosition || this.persistSuspended) return;
    const track = this.current;
    if (!track) return;
    const now = Date.now();
    if (!force && now - this.lastPositionSaveAt < SESSION_POSITION_PERSIST_MS) return;
    this.lastPositionSaveAt = now;
    savePersistedPosition(this.boundAccount, {
      relPath: track.rel_path,
      time: this.storablePosition(track, this.currentTime),
      updatedAt: now,
    });
    // A forced save marks a moment worth syncing (pause, leaving, switching).
    if (!force) return;
    if (this.pauseSyncTimer) {
      window.clearTimeout(this.pauseSyncTimer);
      this.pauseSyncTimer = 0;
    }
    if (deferSync && typeof window !== "undefined") {
      this.pauseSyncTimer = window.setTimeout(() => {
        this.pauseSyncTimer = 0;
        this.emitQueueSync(false, true, true);
      }, 400);
      return;
    }
    this.emitQueueSync(false, true);
  }

  /**
   * A position that may be stored for `track`: within its length. Past the
   * end it belongs to another item (the previous one, a podcast episode),
   * so the track starts from the top instead.
   */
  private storablePosition(track: Track, time: number): number {
    const t = Number.isFinite(time) && time > 0 ? time : 0;
    const d = this.knownDuration(track);
    if (!(d > 0)) return t;
    return t > d + 1 ? 0 : Math.min(t, d);
  }

  /**
   * Where a restored track may resume: never past (or right at) its end; a
   * saved position out of range starts it from the top (0). `length` is the
   * best length known (the hub's, else the element's), 0 when unknown.
   */
  private restorablePosition(time: number, length: number): number {
    if (!Number.isFinite(time) || time < RESTORE_POSITION_MIN_SEC) return 0;
    if (length > 0 && time >= length - 5) return 0;
    return time;
  }

  /**
   * The playback position of `relPath` while it is current and the position
   * really is its own: the active deck holds it, loaded and not failed, with
   * no reconnect or restore seek pending. Null otherwise (the new item still
   * buffering while the previous one plays, a load that failed, a skip under
   * way), so a listener never records another item's or a failed load's
   * position (podcast resume points).
   */
  positionOf(relPath: string): number | null {
    const cur = this.current;
    if (!cur || cur.rel_path !== relPath) return null;
    if (this.remote) return this.currentTime;
    if (this.outage || this.mediaErrorBusy || this.restorePosition || this.crossfadeBusy) return null;
    const a = this.activeAudio();
    if (a.getAttribute("src") !== mediaUrl(relPath) || a.error != null) return null;
    if (a.readyState < 1) return null;
    return Number.isFinite(this.currentTime) ? Math.max(0, this.currentTime) : null;
  }

  /** Seek the restored track to where the last session stopped (once). */
  private applyRestorePosition(audio: HTMLAudioElement) {
    const pos = this.restorePosition;
    if (!pos) return;
    this.restorePosition = null;
    if (this.current?.rel_path !== pos.relPath) return;
    const d = this.deckDuration(audio, this.current);
    if (this.restorablePosition(pos.time, d) <= 0) {
      // Out of range (shown at once by the restore): back to the top.
      this.currentTime = 0;
      this.syncMediaPosition(true);
      this.emitProgress();
      return;
    }
    try {
      audio.currentTime = pos.time;
      this.currentTime = pos.time;
      this.syncMediaPosition(true);
      this.emitProgress();
    } catch {
      /* not seekable yet: start from the top */
    }
  }

  /** The list part of the queue (index excluded): changes far less often. */
  private queueListSig() {
    if (!this.queue.length) return "";
    return this.queue.map((t) => t.rel_path).join("\0");
  }

  private schedulePersistQueue() {
    if (this.restoringSession || this.persistSuspended) return;
    if (this.queue.length === this.lastPersistLen && this.index === this.lastPersistIndex) {
      // Cheap pre-check before joining hundreds of paths on every emit.
      const first = this.queue[0]?.rel_path ?? "";
      const cur = this.queue[this.index]?.rel_path ?? "";
      if (first === this.lastPersistFirst && cur === this.lastPersistCurrent && !this.queueDirty) return;
    }
    if (this.persistQueueTimer) window.clearTimeout(this.persistQueueTimer);
    this.persistQueueTimer = window.setTimeout(() => {
      this.persistQueueTimer = 0;
      this.flushPersistQueue();
    }, SESSION_QUEUE_PERSIST_MS);
  }

  /**
   * Flush queue + currentIndex of the bound account to localStorage (always
   * on, like legacy enqueueQueuePatch), only when the list or the index
   * changed — never on play/pause or progress; the position lives apart.
   */
  flushPersistQueue() {
    if (this.restoringSession || this.persistSuspended) return;
    if (this.persistQueueTimer) {
      window.clearTimeout(this.persistQueueTimer);
      this.persistQueueTimer = 0;
    }
    this.queueDirty = false;
    const listSig = this.queueListSig();
    const listChanged = listSig !== this.lastQueueListSig;
    const cursorChanged = this.index !== this.lastPersistIndex || listChanged;
    this.lastPersistLen = this.queue.length;
    this.lastPersistIndex = this.index;
    this.lastPersistFirst = this.queue[0]?.rel_path ?? "";
    this.lastPersistCurrent = this.queue[this.index]?.rel_path ?? "";
    if (!listChanged && !cursorChanged) return;
    this.lastQueueListSig = listSig;
    this.queueUpdatedAt = Date.now();
    savePersistedSessionQueue(this.boundAccount, this.queue, this.index, this.queueUpdatedAt);
    this.emitQueueSync(listChanged, cursorChanged);
  }

  /**
   * Hub sync of the queue (session → `settings.queue`). The list goes when it
   * changes; the cursor (index + position) on pause, on leaving, on account
   * switch, and at most once a minute while tracks change.
   */
  setQueueSync(fn: ((change: QueueSyncChange) => void) | null) {
    this.queueSync = fn;
  }

  private emitQueueSync(list: boolean, cursor: boolean, force = false) {
    const fn = this.queueSync;
    if (!fn || this.persistSuspended || this.restoringSession) return;
    const now = Date.now();
    if (!list && cursor && !force && this.playing && now - this.lastCursorSyncAt < CURSOR_SYNC_MIN_MS) {
      return;
    }
    if (cursor || list) this.lastCursorSyncAt = now;
    fn({ list, cursor, snapshot: this.queueSnapshot() });
  }

  /** Queue + cursor as the hub stores it. */
  queueSnapshot(): QueueSnapshot {
    // Podcast episodes / live streams stay on this device: the hub copy of
    // the queue lists library tracks only (see `libraryQueueForSync`).
    const lib = libraryQueueForSync(this.queue, this.index);
    const cur = lib.currentIsLibrary ? this.current : (lib.tracks[lib.index] ?? null);
    // The position is the current library track's own, within its length; an
    // episode's position never rides on the library track the cursor names.
    const time = cur && lib.currentIsLibrary ? this.storablePosition(cur, this.currentTime) : 0;
    return {
      relPaths: lib.tracks.map((t) => t.rel_path),
      index: lib.index,
      relPath: cur?.rel_path ?? null,
      time: Math.round(time * 10) / 10,
      updatedAt: Math.max(this.queueUpdatedAt, this.lastPositionSaveAt) || Date.now(),
    };
  }

  /** Account whose queue / position the player reads and writes. */
  get accountId(): string {
    return this.boundAccount;
  }

  /**
   * Saved queue of the bound account on this device (null when none), with
   * the position when it belongs to the current track. For the session to
   * weigh against the hub's copy.
   */
  localQueueSnapshot(): QueueSnapshot | null {
    const persisted = loadPersistedSessionQueue(this.boundAccount);
    if (!persisted?.tracks.length) return null;
    const index = Math.min(persisted.currentIndex, persisted.tracks.length - 1);
    const track = persisted.tracks[index];
    const relPath = track?.rel_path ?? null;
    const pos = loadPersistedPosition(this.boundAccount);
    const time = track && pos && pos.relPath === relPath ? this.storablePosition(track, pos.time) : 0;
    return {
      relPaths: persisted.tracks.map((t) => t.rel_path),
      index,
      relPath,
      time,
      updatedAt: Math.max(persisted.updatedAt ?? 0, pos?.updatedAt ?? 0),
    };
  }

  /**
   * Restore queue + currentIndex (+ position) of the bound account. Always
   * on; never autoplays; remaps ids from the catalog when available.
   * Pass `preferred` (the hub's copy, when newer) to restore that instead.
   */
  restorePersistedQueue(catalog: Track[] = [], preferred?: QueueSnapshot | null): boolean {
    if (this.sessionRestored) return false;
    // User already started listening during bootstrap — keep that session.
    if (this.playing || this.queue.length > 0) {
      this.sessionRestored = true;
      return false;
    }
    const persisted = loadPersistedSessionQueue(this.boundAccount);
    const local = this.localQueueSnapshot();
    const useHub =
      preferred != null &&
      preferred.relPaths.length > 0 &&
      (!local || (preferred.updatedAt || 0) > (local.updatedAt || 0));
    this.sessionRestored = true;
    if (useHub) {
      const snapshot = tracksFromRelPaths(preferred!.relPaths);
      const pos =
        preferred!.relPath && preferred!.time >= RESTORE_POSITION_MIN_SEC
          ? { relPath: preferred!.relPath, time: preferred!.time }
          : null;
      return this.hydrateQueueSnapshot(snapshot, preferred!.index, catalog, pos);
    }
    if (!persisted?.tracks.length) return false;
    this.queueUpdatedAt = persisted.updatedAt ?? 0;
    return this.hydrateQueueSnapshot(persisted.tracks, persisted.currentIndex, catalog);
  }

  /** Restore queue from rel paths (backup/user-state) without autoplay. */
  hydrateQueueFromRelPaths(
    relPaths: string[],
    currentIndex: number,
    catalog: Track[] = [],
  ): boolean {
    if (!relPaths.length) return false;
    if (this.playing || this.queue.length > 0) {
      this.sessionRestored = true;
      return false;
    }
    this.sessionRestored = true;
    const ok = this.hydrateQueueSnapshot(tracksFromRelPaths(relPaths), currentIndex, catalog);
    // A queue restored from elsewhere is this account's queue from now on.
    if (ok) this.emitQueueSync(true, true, true);
    return ok;
  }

  /** Whether the player has already restored (or started) a session. */
  get sessionWasRestored(): boolean {
    return this.sessionRestored;
  }

  private hydrateQueueSnapshot(
    snapshot: Track[],
    currentIndex: number,
    catalog: Track[] = [],
    position?: { relPath: string; time: number } | null,
  ): boolean {
    if (!snapshot.length) return false;
    // Never tear down a live listening session (refresh races, duplicate restore).
    if (this.playing || this.queue.length > 0) return false;
    const byPath = new Map(catalog.map((t) => [t.rel_path, t]));
    const tracks = snapshot.map((t) => byPath.get(t.rel_path) ?? t);
    const index = Math.max(0, Math.min(currentIndex, tracks.length - 1));

    this.restoringSession = true;
    try {
      this.cancelPendingLoad();
      this.abortCrossfade();
      this.privateQueue = [...tracks];
      this.queue = [...tracks];
      this.queueDirty = true;
      this.index = index;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 0;
      this.consecutiveErrors = 0;
      const track = this.current;
      if (track) {
        const audio = this.activeAudio();
        audio.loop = this.repeat === "one";
        const pos = position ?? loadPersistedPosition(this.boundAccount);
        // The hub's duration is the seek bar's length at once (no wait on the file).
        if (track.duration_ms > 0) this.duration = track.duration_ms / 1000;
        const at =
          pos && pos.relPath === track.rel_path
            ? this.restorablePosition(pos.time, this.knownDuration(track))
            : 0;
        if (pos && at > 0) {
          this.restorePosition = { relPath: pos.relPath, time: at };
          // Show it at once; the element seeks when metadata arrives.
          this.currentTime = at;
        }
        audio.src = mediaUrl(track.rel_path);
        this.updateMediaSession(track);
      }
      this.lastQueueListSig = this.queueListSig();
      this.lastPersistIndex = this.index;
      this.lastPersistLen = this.queue.length;
      this.lastPersistFirst = this.queue[0]?.rel_path ?? "";
      this.lastPersistCurrent = this.queue[this.index]?.rel_path ?? "";
      if (!this.queueUpdatedAt) this.queueUpdatedAt = Date.now();
      savePersistedSessionQueue(this.boundAccount, this.queue, this.index, this.queueUpdatedAt);
      if (this.restorePosition) {
        savePersistedPosition(this.boundAccount, {
          relPath: this.restorePosition.relPath,
          time: this.restorePosition.time,
          updatedAt: this.queueUpdatedAt,
        });
      }
      this.emit();
    } finally {
      this.restoringSession = false;
    }
    return true;
  }

  /**
   * Account switch, step 1 (old account still bound): save its queue and
   * position locally and hand the snapshot to the hub sync, then stop
   * playback and empty the player without writing anything — the queue on
   * disk stays the old account's. Returns the old account's snapshot.
   */
  releaseAccount(opts?: { sync?: boolean }): QueueSnapshot | null {
    const had = this.queue.length > 0;
    // The binding may already point elsewhere (another tab, a dead account):
    // then the snapshot must not reach the hub sync, which speaks for it.
    const sync = opts?.sync !== false;
    const syncFn = this.queueSync;
    if (!sync) this.queueSync = null;
    if (this.remote) this.remote.pause();
    // Position first: the element still knows where it is.
    if (this.current && !this.remote) {
      const el = this.activeAudio();
      if (Number.isFinite(el.currentTime) && el.currentTime > 0) this.currentTime = el.currentTime;
    }
    this.flushPersistQueue();
    this.persistPosition(true);
    const snapshot = had ? this.queueSnapshot() : null;
    if (sync) this.emitQueueSync(true, true, true);
    this.queueSync = syncFn;
    this.persistSuspended = true;
    try {
      this.cancelPendingLoad();
      this.abortCrossfade();
      this.cancelPendingSeek();
      this.manualQueuedPaths.clear();
      this.expectPause("user");
      this.playRetry = false;
      this.deck0.pause();
      this.deck1.pause();
      for (const el of [this.deck0, this.deck1]) {
        try {
          el.removeAttribute("src");
          el.load();
        } catch {
          /* already empty */
        }
      }
      this.prefetchedRelPath = null;
      this.queue = [];
      this.privateQueue = [];
      this.index = -1;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 0;
      this.restorePosition = null;
      this.outage = null;
      this.consecutiveErrors = 0;
      this.resetHalfListen(null);
      this.updateMediaSession(null);
      this.emit();
      this.emitProgress();
    } finally {
      // Stays suspended until `bindAccount`: the empty player must never be
      // written over the released account's saved queue.
      this.persistSuspended = true;
    }
    return snapshot;
  }

  /**
   * Account switch, step 2: from now on queue and position belong to
   * `accountId`. The next `restorePersistedQueue` restores its session.
   */
  bindAccount(accountId: string | null | undefined) {
    const next = accountSuffix(accountId);
    this.persistSuspended = false;
    if (next === this.boundAccount) return;
    this.boundAccount = next;
    this.sessionRestored = false;
    this.lastQueueListSig = "";
    this.lastPersistIndex = -1;
    this.lastPersistLen = -1;
    this.lastPersistFirst = "";
    this.lastPersistCurrent = "";
    this.queueUpdatedAt = 0;
    this.lastPositionSaveAt = 0;
    this.lastCursorSyncAt = 0;
  }

  // ---- Guards (hold, seek lock, crossfade override) -------------------------

  /**
   * Hold the player (`null` releases): no auto-advance and no crossfade into
   * the next track. A held track plays to its end and stops there; then
   * `heldEnded` is true and `onHeldEnd` listeners fire. Repeat-one looping is
   * off while held (the end must be reached).
   */
  setHold(reason: string | null) {
    if (!this.guards.setHold(reason)) return;
    const a = this.activeAudio();
    a.loop = this.guards.held ? false : this.repeat === "one";
    if (this.guards.held) {
      // A fade already under way finishes on the next track: undo it.
      if (this.crossfadeBusy) this.abortCrossfade();
    } else {
      this.heldEndedFlag = false;
    }
    this.emit();
  }

  /** Why the player is held, or null. */
  get holdReason(): string | null {
    return this.guards.hold;
  }

  /** A held track reached its end and the player is waiting. */
  get heldEnded(): boolean {
    return this.heldEndedFlag;
  }

  /** Called with the track that ended while held. Returns an unsubscribe. */
  onHeldEnd(fn: (track: Track | null) => void): () => void {
    this.heldEndListeners.add(fn);
    return () => this.heldEndListeners.delete(fn);
  }

  private finishHeldTrack() {
    this.heldEndedFlag = true;
    this.pauseReason = "ended";
    this.playing = false;
    if (this.duration > 0) this.currentTime = this.duration;
    this.syncMediaPlaybackState();
    this.emit();
    this.emitProgress();
    const track = this.current;
    for (const fn of [...this.heldEndListeners]) {
      try {
        fn(track);
      } catch {
        /* a listener must not break playback */
      }
    }
  }

  /**
   * Crossfade seconds replacing the user's setting until `null`. Never saved
   * to prefs; `crossfadeSec` keeps reporting the user's value.
   */
  setCrossfadeOverride(sec: number | null) {
    if (!this.guards.setCrossfadeOverride(sec)) return;
    if (this.crossfadeBusy && this.effectiveCrossfadeSec === 0) this.abortCrossfade();
    this.emit();
  }

  /** The crossfade in use (override, else the user's setting). */
  get effectiveCrossfadeSec(): number {
    return this.guards.crossfade(this.crossfadeSec);
  }

  /**
   * Refuse user seeks (`null` releases): dock timeline, media keys, keyboard
   * shortcuts. `seek(t, { force: true })` still works for the lock owner.
   */
  setSeekLock(reason: string | null) {
    if (!this.guards.setSeekLock(reason)) return;
    if (this.guards.seekLocked) this.cancelPendingSeek();
    this.emit();
  }

  get seekLocked(): boolean {
    return this.guards.seekLocked;
  }

  get seekLockReason(): string | null {
    return this.guards.seekLock;
  }

  /**
   * Make `track` current: its index when it is in the queue, else a queue of
   * `opts.queue` (or the track alone). With `autoplay: false` it is prepared
   * paused at 0:00 — the previous track stops at once, nothing is heard.
   * Resolves once the track is loaded (or the load was superseded).
   */
  async load(
    track: Track,
    opts: { autoplay?: boolean; queue?: Track[] } = {},
  ): Promise<void> {
    const autoplay = opts.autoplay !== false;
    this.cancelPendingLoad();
    this.abortCrossfade();
    let idx = opts.queue ? -1 : this.queue.findIndex((t) => t.rel_path === track.rel_path);
    if (idx < 0) {
      const list = opts.queue?.length ? opts.queue : [track];
      idx = Math.max(0, list.findIndex((t) => t.rel_path === track.rel_path));
      this.manualQueuedPaths.clear();
      this.privateQueue = [...list];
      this.queue = [...list];
      this.queueDirty = true;
    }
    this.index = idx;
    await this.loadCurrent(autoplay);
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

  // ---- Levels -------------------------------------------------------------
  //
  // Every level is a plan (`LevelRamp`): per-deck crossfade level times the
  // master (sleep fade) level. An unwired deck plays at that product through
  // `element.volume`, resampled every LEVEL_TICK_MS while something moves. A
  // deck wired into the analyser graph keeps `element.volume = 1`; its level
  // is scheduled on its GainNode and the master on `outputGain`, so the level
  // is never applied twice and switching mid-fade continues the same plan.

  /** Move each deck's crossfade level to `levels`, over `durationMs` (0 = now). */
  private setDeckLevels(levels: [number, number], durationMs = 0) {
    const now = nowMs();
    this.deckLevels = [
      retargetLevel(this.deckLevels[0], levels[0], now, durationMs),
      retargetLevel(this.deckLevels[1], levels[1], now, durationMs),
    ];
    this.applyLevels(now);
  }

  /** Move the master (sleep fade) level to `level`, over `durationMs` (0 = now). */
  private setMasterLevel(level: number, durationMs = 0) {
    const now = nowMs();
    this.masterLevel = retargetLevel(this.masterLevel, level, now, durationMs);
    this.applyLevels(now);
  }

  /** Only `ix` heard, at once (track swap, aborted fade). */
  private snapSolo(ix: DeckIx) {
    this.setDeckLevels(ix === 0 ? [1, 0] : [0, 1]);
  }

  /** Push the current plan to wherever each level lives (GainNode or element). */
  private applyLevels(now = nowMs()) {
    const ctx = this.ctx;
    for (const ix of [0, 1] as const) {
      const gain = this.gains[ix];
      if (ctx && gain && this.sources[ix]) {
        this.scheduleParam(ctx, gain.gain, this.deckLevels[ix], now);
        this.setElementVolume(this.deckEl(ix), 1);
      }
    }
    if (ctx && this.outputGain) this.scheduleParam(ctx, this.outputGain.gain, this.masterLevel, now);
    this.applyElementLevels(now);
  }

  /** Sample the plan into the volume of every deck not wired into the graph. */
  private applyElementLevels(now = nowMs()) {
    const master = levelAt(this.masterLevel, now);
    for (const ix of [0, 1] as const) {
      if (this.sources[ix]) continue;
      this.setElementVolume(this.deckEl(ix), elementVolume(levelAt(this.deckLevels[ix], now), master));
    }
    this.syncLevelTicker(now);
  }

  /**
   * WebKitGTK reports the sound server's stream volume back into the element,
   * late: an echo of an older write can land after the last step of a fade
   * and leave the new track playing at 15%. Once the echoes settle, put back
   * the level this player wrote (one write; its own echo matches).
   */
  private onDeckVolumeEcho(el: HTMLAudioElement) {
    const wanted = this.writtenVolume.get(el);
    if (wanted == null || typeof window === "undefined") return;
    window.clearTimeout(this.volumeEchoTimers.get(el));
    this.volumeEchoTimers.set(
      el,
      window.setTimeout(() => {
        this.volumeEchoTimers.delete(el);
        const target = this.writtenVolume.get(el);
        if (target == null || Math.abs(el.volume - target) < 0.01) return;
        try {
          el.volume = target;
        } catch {
          /* ignore */
        }
      }, 300),
    );
  }

  private setElementVolume(el: HTMLAudioElement, v: number) {
    const q = quantizeVolume(v, VOLUME_STEP);
    // Compare with what we wrote, not with `el.volume`: an engine that
    // rounds the value (the sound server's own scale) would otherwise get a
    // fresh write on every tick, and echo it back again.
    const last = this.writtenVolume.get(el) ?? el.volume;
    if (Math.abs(last - q) < 1e-4) return;
    this.writtenVolume.set(el, q);
    try {
      el.volume = q;
    } catch {
      /* out-of-range guard: quantizeVolume already clamps */
    }
  }

  /** Keep the resampling timer alive only while an unwired deck has a moving level. */
  private syncLevelTicker(now: number) {
    const unwired = !this.sources[0] || !this.sources[1];
    const moving =
      rampActive(this.deckLevels[0], now) ||
      rampActive(this.deckLevels[1], now) ||
      rampActive(this.masterLevel, now);
    const need = unwired && moving && typeof window !== "undefined";
    if (need && !this.levelTicker) {
      this.levelTicker = window.setInterval(() => this.applyElementLevels(), LEVEL_TICK_MS);
    } else if (!need && this.levelTicker) {
      window.clearInterval(this.levelTicker);
      this.levelTicker = 0;
    }
  }

  /** Same plan on the audio thread: exact even when the page's timers are throttled. */
  private scheduleParam(ctx: AudioContext, param: AudioParam, ramp: LevelRamp, now: number) {
    const t = ctx.currentTime;
    const v = levelAt(ramp, now);
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
      if (rampActive(ramp, now)) {
        param.linearRampToValueAtTime(ramp.to, t + (ramp.endMs - now) / 1000);
      }
    } catch {
      param.value = v;
    }
  }

  // ---- Analyser graph -------------------------------------------------------

  /**
   * Take a lease on the analyser. The first lease builds the Web Audio graph
   * and routes the decks through it (as soon as the context runs); the
   * returned release is idempotent. While no lease is held the decks play
   * directly, which is far cheaper on WebKitGTK. Read the node per frame with
   * `getAnalyser()` — it is null until the decks are actually routed.
   */
  acquireAnalyser(): () => void {
    return this.analyserLeases.acquire();
  }

  /** On/off handle over `acquireAnalyser` for components (call `set` freely, `dispose` on destroy). */
  analyserLease(): LeaseSwitch {
    return createLeaseSwitch(() => this.acquireAnalyser());
  }

  /**
   * The analyser, while the graph is engaged (some lease is or was held and a
   * deck is routed through it); null otherwise. Never builds the graph: take a
   * lease with `acquireAnalyser` / `analyserLease` for that.
   */
  getAnalyser(): AnalyserNode | null {
    if (!this.graphWired()) return null;
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") {
      void ctx.resume().catch(() => {});
    }
    return this.analyser;
  }

  /**
   * Crossfade and sleep fade normally ramp `element.volume`. Where that is
   * ignored (iOS), keep the old behaviour instead: the graph is engaged from
   * the first play (called from play paths, so a user gesture can start the
   * context) and stays for the session.
   */
  private ensureFadeControl() {
    if (this.fadeLease || elementVolumeWorks()) return;
    this.fadeLease = this.acquireAnalyser();
  }

  private graphWired(): boolean {
    return this.sources[0] != null || this.sources[1] != null;
  }

  /** First lease: build the graph (nodes only), wire the decks once the context runs. */
  private engageGraph() {
    // Taken again within the grace window: the graph never went away.
    this.cancelGraphIdleDrop();
    if (!this.ctx) {
      const Ctor =
        typeof window !== "undefined"
          ? (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : undefined;
      if (!Ctor) return;
      try {
        const ctx = new Ctor();
        const g0 = ctx.createGain();
        const g1 = ctx.createGain();
        const out = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.62;
        analyser.minDecibels = -88;
        analyser.maxDecibels = -28;
        g0.connect(out);
        g1.connect(out);
        // Match legacy: output → analyser → destination
        out.connect(analyser);
        analyser.connect(ctx.destination);
        ctx.onstatechange = () => {
          if (ctx === this.ctx) this.wireDecks();
        };
        this.ctx = ctx;
        this.gains = [g0, g1];
        this.outputGain = out;
        this.analyser = analyser;
      } catch {
        this.ctx = null;
        return;
      }
    }
    const ctx = this.ctx;
    if (ctx.state === "running") this.wireDecks();
    // Outside a user gesture this may stay suspended (autoplay policy): the
    // decks are then left alone — routing them into a silent context would
    // mute playback — and get wired by `onstatechange` once a play gesture
    // resumes it (see `resumeGraphForPlay`).
    else void ctx.resume().catch(() => {});
  }

  /**
   * Route every not-yet-routed deck through its GainNode. Only while a lease
   * is held and the context runs. The gain takes the deck's current level
   * before the element switches to volume 1, so there is no jump — even in
   * the middle of a crossfade or sleep fade.
   */
  private wireDecks() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.analyserLeases.count === 0) return;
    const now = nowMs();
    let changed = false;
    if (this.outputGain) this.scheduleParam(ctx, this.outputGain.gain, this.masterLevel, now);
    for (const ix of [0, 1] as const) {
      const gain = this.gains[ix];
      if (this.sources[ix] || !gain) continue;
      this.scheduleParam(ctx, gain.gain, this.deckLevels[ix], now);
      try {
        const src = ctx.createMediaElementSource(this.deckEl(ix));
        src.connect(gain);
        this.sources[ix] = src;
        changed = true;
      } catch {
        /* this element cannot be routed: it keeps playing directly */
      }
    }
    if (changed) this.applyLevels(now);
  }

  /**
   * Last lease released: the graph goes once its decks can be swapped out,
   * but only after GRAPH_IDLE_GRACE_MS without a new lease (pause → play
   * must not rebuild it).
   */
  private onAnalyserIdle() {
    if (!this.ctx) return;
    if (typeof window === "undefined") {
      this.dropIdleGraph();
      return;
    }
    this.cancelGraphIdleDrop();
    this.graphIdleTimer = window.setTimeout(() => {
      this.graphIdleTimer = 0;
      this.dropIdleGraph();
    }, GRAPH_IDLE_GRACE_MS);
  }

  private cancelGraphIdleDrop() {
    if (!this.graphIdleTimer) return;
    window.clearTimeout(this.graphIdleTimer);
    this.graphIdleTimer = 0;
  }

  private dropIdleGraph() {
    if (!this.ctx || this.analyserLeases.count > 0) return;
    if (!this.graphWired()) {
      this.closeGraph();
      return;
    }
    this.maybeDropGraph();
  }

  /**
   * With no lease held, swap each idle routed deck (inactive, paused, empty)
   * for a fresh element that plays directly; once neither deck is routed, close
   * the context. The active deck is never touched: it is swapped after it
   * stops being active (next track change), so playback never gaps.
   */
  private maybeDropGraph() {
    if (!this.ctx || this.analyserLeases.count > 0) return;
    // Still inside the grace window: the timer retries when it ends.
    if (this.graphIdleTimer) return;
    if (!this.graphWired()) {
      this.closeGraph();
      return;
    }
    if (!deckRebuildSafe()) return;
    if (this.crossfadeBusy || this.deckOpsInFlight > 0) return;
    const ix: DeckIx = this.active === 0 ? 1 : 0;
    const el = this.deckEl(ix);
    if (this.sources[ix] && el.paused && !el.getAttribute("src")) this.replaceDeck(ix);
    if (!this.graphWired()) this.closeGraph();
  }

  private replaceDeck(ix: DeckIx) {
    const old = this.deckEl(ix);
    this.deckBindings[ix]?.abort();
    this.deckBindings[ix] = null;
    try {
      old.pause();
      old.removeAttribute("src");
      old.load();
    } catch {
      /* already empty */
    }
    try {
      this.sources[ix]?.disconnect();
    } catch {
      /* ignore */
    }
    this.sources[ix] = null;
    const fresh = this.createDeck(ix);
    if (ix === 0) this.deck0 = fresh;
    else this.deck1 = fresh;
    // Its level goes back from the GainNode to the element.
    this.applyLevels();
  }

  /** Only once no deck is routed: closing earlier would mute that deck for good. */
  private closeGraph() {
    const ctx = this.ctx;
    if (!ctx || this.graphWired()) return;
    ctx.onstatechange = null;
    this.ctx = null;
    this.gains = [null, null];
    this.outputGain = null;
    this.analyser = null;
    void ctx.close().catch(() => {});
  }

  /**
   * Before starting a deck. A routed deck is silent until the context runs,
   * so then the caller must await the returned promise. With no routed deck
   * the play never waits; resuming is still attempted (inside a user gesture
   * this is what lets a pending graph start, e.g. on iOS).
   */
  private resumeGraphForPlay(): Promise<void> | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return null;
    const p = ctx.resume().catch(() => {});
    if (!this.graphWired()) return null;
    // Never wait on it unbounded: a resume that stays pending (seen on
    // WebKitGTK) would leave play/pause and the crossfade hanging on it.
    if (typeof window === "undefined") return p;
    return Promise.race([
      p,
      new Promise<void>((resolve) => window.setTimeout(resolve, GRAPH_RESUME_TIMEOUT_MS)),
    ]);
  }

  /**
   * The deck currently heard (the outgoing one until a crossfade swaps).
   * Read-only use: clocks, visualizers. Null while a remote output plays —
   * the local elements are silent and their time is stale then.
   */
  getActiveAudio(): HTMLAudioElement | null {
    if (this.remote) return null;
    return this.activeAudio();
  }

  /**
   * The deck holding `relPath`, preferring one that is playing (during a
   * crossfade both decks may be busy). Null when no deck has that file or a
   * remote output plays.
   */
  getAudioForTrack(relPath: string): HTMLAudioElement | null {
    if (this.remote || !relPath) return null;
    const src = mediaUrl(relPath);
    const active = this.activeAudio();
    const other = this.inactiveDeck();
    let match: HTMLAudioElement | null = null;
    for (const el of [active, other]) {
      if (el.getAttribute("src") !== src) continue;
      if (!match || (match.paused && !el.paused)) match = el;
    }
    return match;
  }

  private activeAudio() {
    return this.active === 0 ? this.deck0 : this.deck1;
  }


  private persistExclusions() {
    patchUserPrefs({
      excludedRelPaths: [...this.excludedRelPaths],
      excludedTrackIds: [],
      excludedAlbumIds: [...this.excludedAlbumIds],
    });
  }

  /** Apply crossfade without writing prefs (hydrate / account switch). */
  applyCrossfadeSec(sec: CrossfadeSec) {
    this.crossfadeSec = sec;
    this.emit();
  }

  setCrossfadeSec(sec: CrossfadeSec) {
    this.crossfadeSec = sec;
    patchUserPrefs({ crossfadeSec: sec });
    this.emit();
  }

  toggleExcludeTrack(track: Track) {
    if (isExternalTrack(track)) return;
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

  private resetHalfListen(track: Track | null) {
    this.halfListenPath = track?.rel_path ?? null;
    this.halfListenCounted = false;
  }

  /** Legacy PlayerContext: increment at ≥50% duration; re-arm if seeked <10%. */
  private maybeCountHalfListen() {
    const track = this.current;
    // Podcasts and live streams never count as plays (stats, achievements).
    if (!track || !countsTowardStats(track)) return;
    const path = track.rel_path;
    if (this.halfListenPath !== path) {
      this.halfListenPath = path;
      this.halfListenCounted = false;
    }
    const audio = this.activeAudio();
    const safeDuration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : this.duration > 0
          ? this.duration
          : 0;
    if (!safeDuration) return;
    if (this.halfListenCounted && audio.currentTime < safeDuration * 0.1) {
      this.halfListenCounted = false;
    }
    if (!this.halfListenCounted && audio.currentTime >= safeDuration * 0.5) {
      this.halfListenCounted = true;
      this.bumpPlayCount(track);
      this.emit();
    }
  }

  private bumpPlayCount(track: Track) {
    if (!countsTowardStats(track)) return;
    // The cached map is shared and frozen: build the next one.
    const counts = { ...getPlayCountsMap(this.boundAccount) };
    const key = track.rel_path;
    const prev = playCountIn(counts, track);
    counts[key] = prev + 1;
    delete counts[String(track.id)];
    patchUserPrefs({ playCounts: counts }, this.boundAccount);
    touchListeningActivity();
  }

  /** Recent history on start (legacy pushRecent) — deferred so click stays snappy. */
  private pushRecentDeferred(track: Track) {
    // The library history only: podcasts keep their own (podcast state).
    if (!countsTowardStats(track)) return;
    const path = track.rel_path;
    window.setTimeout(() => {
      if (this.current?.rel_path !== path) return;
      const recent = [
        path,
        ...getRecentRelPaths(this.boundAccount).filter((p) => p !== path),
      ].slice(0, 80);
      patchUserPrefs({ recentRelPaths: recent, recentTrackIds: [] }, this.boundAccount);
      this.emit();
    }, 0);
  }

  /** Cheap (in-memory prefs). Lists should prefer `prefsRevision.playCountsMap`. */
  playCount(track: { id: number; rel_path: string } | number) {
    const counts = getPlayCountsMap();
    if (typeof track === "number") {
      return counts[String(track)] ?? 0;
    }
    return playCountIn(counts, track);
  }

  recentRelPaths(): string[] {
    return [...getRecentRelPaths()];
  }

  /** @deprecated use recentRelPaths — kept for brief call-site migration */
  recentTrackIds() {
    return [] as number[];
  }

  clearRecent() {
    patchUserPrefs({ recentRelPaths: [], recentTrackIds: [] });
    this.emit();
  }

  /** Shared, read-only map of the bound account's play counts. */
  allPlayCounts(): Readonly<Record<string, number>> {
    return getPlayCountsMap();
  }

  filterShufflePool(tracks: Track[], seed: Track | null = null) {
    if (seed && this.isTrackExcluded(seed)) return [...tracks];
    return tracks.filter(
      (t) => (seed != null && t.rel_path === seed.rel_path) || !this.isTrackExcluded(t),
    );
  }

  private exclusionOpts(respectExclusions = true) {
    return {
      respectExclusions,
      isExcluded: (t: Track) => this.isTrackExcluded(t),
    };
  }

  private recentRelPathSet() {
    return new Set(getRecentRelPaths().slice(0, 48));
  }

  /**
   * Replaces the queue and starts from startIndex.
   * - preserveQueueOrder: order unchanged even with shuffle ON (album / playlist).
   * - shuffle ON without preserve: keeps the prefix up to the track and shuffles only the rest.
   */
  playTracks(
    tracks: Track[],
    startIndex = 0,
    opts?: { preserveQueueOrder?: boolean; autoplay?: boolean },
  ) {
    if (!tracks.length) return;
    this.cancelPendingLoad();
    this.abortCrossfade();
    this.manualQueuedPaths.clear();
    const idx = Math.min(Math.max(0, startIndex), tracks.length - 1);
    this.privateQueue = [...tracks];
    const shouldShuffleTail =
      this.shuffle && tracks.length > 1 && !opts?.preserveQueueOrder;
    if (shouldShuffleTail) {
      const start = tracks[idx]!;
      // Start the clicked track immediately; full queue on the next frame.
      this.queue = [start];
      this.queueDirty = true;
      this.index = 0;
      void this.loadCurrent(true);
      const gen = this.loadGen;
      const startPath = start.rel_path;
      const all = tracks;
      const focus = idx;
      window.setTimeout(() => {
        if (this.loadGen !== gen) return;
        if (this.current?.rel_path !== startPath) return;
        const ordered = shuffleTailFromCurrent(all, focus);
        this.privateQueue = [...all];
        this.queue = ordered;
        this.queueDirty = true;
        this.index = focus;
        this.emit();
      }, 0);
      return;
    }
    this.queue = [...this.privateQueue];
    this.queueDirty = true;
    this.index = idx;
    void this.loadCurrent(opts?.autoplay !== false);
  }

  playTrack(
    track: Track,
    context: Track[] = [track],
    opts?: { preserveQueueOrder?: boolean; autoplay?: boolean },
  ) {
    const idx = context.findIndex((t) => t.id === track.id);
    this.playTracks(context, idx >= 0 ? idx : 0, opts);
  }

  /** Album / playlist / ordered queue: does not reshuffle even if shuffle is ON. */
  playSequence(tracks: Track[], startIndex = 0) {
    this.playTracks(tracks, startIndex, { preserveQueueOrder: true });
  }

  /** Jumps to an index of the current queue without rebuilding it. */
  playQueueIndex(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    this.cancelPendingLoad();
    this.abortCrossfade();
    this.index = index;
    void this.loadCurrent(true);
  }

  /**
   * Smart shuffle of a pool.
   * With seed: seed first + smart rest (collection / genre / mood).
   * Without seed: all smart-random (Listen / Play all).
   */
  playShuffled(tracks: Track[], start?: Track) {
    if (!tracks.length) return;
    const seed =
      start && tracks.some((t) => t.rel_path === start.rel_path) ? start : null;
    const pool = this.filterShufflePool(tracks, seed);
    if (!pool.length) return;

    this.cancelPendingLoad();
    this.abortCrossfade();
    this.manualQueuedPaths.clear();
    this.shuffle = true;

    const recent = this.recentRelPathSet();
    const full = seed
      ? buildShuffleQueueFromSeed(seed, tracks, {
          recentRelPaths: recent,
          ...this.exclusionOpts(true),
        })
      : buildSmartRandomQueue(pool, {
          recentRelPaths: recent,
        }).slice(0, CARD_QUEUE_CAP);

    if (!full.length) return;
    const first = full[0]!;
    // privateQueue = source order (to restore when shuffle is turned off).
    this.privateQueue = seed ? [...tracks] : [...pool];
    this.queue = [first];
    this.queueDirty = true;
    this.index = 0;
    void this.loadCurrent(true);
    const gen = this.loadGen;
    const firstPath = first.rel_path;
    window.setTimeout(() => {
      if (this.loadGen !== gen) return;
      if (this.current?.rel_path !== firstPath) return;
      this.queue = full;
      this.queueDirty = true;
      this.index = 0;
      this.emit();
    }, 0);
  }

  playCollectionShuffle(seed: Track, pool: Track[], respectExclusions = true) {
    if (!pool.length) return;
    const recent = this.recentRelPathSet();
    const full = buildShuffleQueueFromSeed(seed, pool, {
      recentRelPaths: recent,
      ...this.exclusionOpts(respectExclusions),
    });
    if (!full.length) return;
    this.cancelPendingLoad();
    this.abortCrossfade();
    this.manualQueuedPaths.clear();
    this.shuffle = true;
    const first = full[0]!;
    this.privateQueue = [...pool];
    this.queue = [first];
    this.queueDirty = true;
    this.index = 0;
    void this.loadCurrent(true);
    const gen = this.loadGen;
    const firstPath = first.rel_path;
    window.setTimeout(() => {
      if (this.loadGen !== gen) return;
      if (this.current?.rel_path !== firstPath) return;
      this.queue = full;
      this.queueDirty = true;
      this.index = 0;
      this.emit();
    }, 0);
  }

  playPoolShuffle(pool: Track[], respectExclusions = true) {
    const eligible = respectExclusions
      ? this.filterShufflePool(pool)
      : [...pool];
    if (!eligible.length) return;
    this.playShuffled(eligible);
  }

  /** Smart radio from a seed track across a library pool. */
  playRadioFromSeed(seed: Track, library: Track[], respectExclusions = true) {
    this.cancelPendingLoad();
    this.abortCrossfade();
    this.manualQueuedPaths.clear();
    this.shuffle = true;
    // Start audio on the seed immediately; score the library after paint.
    this.privateQueue = [seed];
    this.queue = [seed];
    this.queueDirty = true;
    this.index = 0;
    void this.loadCurrent(true);
    const gen = this.loadGen;
    const seedPath = seed.rel_path;
    window.setTimeout(() => {
      if (this.loadGen !== gen) return;
      if (this.current?.rel_path !== seedPath) return;
      const recent = this.recentRelPathSet();
      const queue = buildRadioFromSeed(seed, library, {
        maxLength: CARD_QUEUE_CAP,
        recentRelPaths: recent,
        ...this.exclusionOpts(respectExclusions),
      });
      if (!queue.length) return;
      this.privateQueue = [...queue];
      this.queue = queue;
      this.queueDirty = true;
      this.index = 0;
      this.emit();
    }, 0);
  }

  /**
   * Radio from the current track: keeps the already-played prefix and
   * replaces only the upcoming queue (legacy playRadioFromCurrent).
   */
  playRadioFromCurrent(library: Track[], respectExclusions = true) {
    const cur = this.current;
    if (!cur || !library.length) return;
    const curIdx = this.index;
    const generated = buildRadioFromSeed(cur, library, {
      maxLength: CARD_QUEUE_CAP,
      recentRelPaths: this.recentRelPathSet(),
      ...this.exclusionOpts(respectExclusions),
    });
    const prefix = this.queue.slice(0, curIdx + 1);
    const prefixPaths = new Set(prefix.map((t) => t.rel_path));
    const newTail = generated.slice(1).filter((t) => !prefixPaths.has(t.rel_path));
    const newFull = [...prefix, ...newTail].slice(0, CARD_QUEUE_CAP);
    this.replaceQueueKeepingPlayback(newFull);
  }

  replaceQueueKeepingPlayback(fullQueue: Track[]) {
    if (!fullQueue.length) return;
    const currentPath = this.queue[this.index]?.rel_path ?? this.current?.rel_path;
    if (!currentPath) return;
    let focusIdx = fullQueue.findIndex((t) => t.rel_path === currentPath);
    if (focusIdx < 0) focusIdx = Math.min(this.index, fullQueue.length - 1);
    this.manualQueuedPaths.clear();
    this.privateQueue = [...fullQueue];
    this.queue = [...fullQueue];
    this.queueDirty = true;
    this.index = focusIdx;
    this.emit();
  }

  addToQueue(track: Track | Track[]) {
    const list = Array.isArray(track) ? track : [track];
    if (!list.length) return;
    if (!this.queue.length) {
      this.playSequence(list, 0);
      return;
    }
    const seen = new Set(this.queue.map((t) => t.rel_path));
    const add = list.filter((t) => !seen.has(t.rel_path));
    if (!add.length) return;
    const at = computeQueueInsertIndex(this.queue, {
      currentRelPath: this.current?.rel_path ?? null,
      currentIndex: Math.max(0, this.index),
      crossfadeBusy: this.crossfadeBusy,
      crossfadeNextIndex: this.crossfadeNextIdx,
      manualQueuedPaths: this.manualQueuedPaths,
    });
    for (const t of add) this.manualQueuedPaths.add(t.rel_path);
    this.queue = insertTracksInQueue(this.queue, add, at);
    this.queueDirty = true;
    const curPath = this.current?.rel_path;
    const privFocus = curPath
      ? this.privateQueue.findIndex((t) => t.rel_path === curPath)
      : -1;
    const privAt =
      privFocus >= 0
        ? computeQueueInsertIndex(this.privateQueue, {
            currentRelPath: curPath ?? null,
            currentIndex: privFocus,
            crossfadeBusy: false,
            crossfadeNextIndex: null,
            manualQueuedPaths: this.manualQueuedPaths,
          })
        : this.privateQueue.length;
    this.privateQueue = insertTracksInQueue(this.privateQueue, add, privAt);
    this.emit();
  }

  removeFromQueue(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    const removedPath = this.queue[index]?.rel_path;
    if (removedPath) this.manualQueuedPaths.delete(removedPath);
    const removingCurrent = index === this.index;
    this.queue = this.queue.filter((_, i) => i !== index);
    this.queueDirty = true;
    this.privateQueue = this.queue.slice();
    if (!this.queue.length) {
      this.index = -1;
      this.pauseHard();
      this.emit();
      return;
    }
    if (removingCurrent) {
      this.cancelPendingLoad();
      this.abortCrossfade();
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

  /**
   * Library metadata changed (title, genre, lyrics, cover version…): swap the
   * edited fields into every queue entry `patchFor` returns a patch for, so
   * the player bar, Listen view, queue and OS media controls show the new
   * values at once. Playback is untouched (same paths, same index).
   */
  patchTracks(patchFor: (track: Track) => Partial<Track> | null | undefined): boolean {
    const patchList = (list: Track[]) => {
      let changed = false;
      const next = list.map((t) => {
        const patch = patchFor(t);
        if (!patch) return t;
        const keys = Object.keys(patch) as (keyof Track)[];
        if (!keys.some((k) => t[k] !== patch[k])) return t;
        changed = true;
        return { ...t, ...patch };
      });
      return changed ? next : null;
    };
    const queue = patchList(this.queue);
    if (!queue) return false;
    const before = this.current;
    this.queue = queue;
    this.privateQueue = patchList(this.privateQueue) ?? this.privateQueue;
    const after = this.current;
    if (after && after !== before) this.updateMediaSession(after);
    savePersistedSessionQueue(this.boundAccount, this.queue, this.index, this.queueUpdatedAt);
    this.emit();
    return true;
  }

  /** For files gone from disk: the same path can sit in the queue more than once. */
  removeFromQueueByRelPath(relPath: string) {
    for (;;) {
      const i = this.queue.findIndex((t) => t.rel_path === relPath);
      if (i < 0) return;
      this.removeFromQueue(i);
    }
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
    this.queueDirty = true;
    this.privateQueue = next.slice();
    this.index = idx;
    this.emit();
  }

  clearQueue() {
    this.cancelPendingLoad();
    this.abortCrossfade();
    this.manualQueuedPaths.clear();
    this.queue = [];
    this.privateQueue = [];
    this.index = -1;
    this.pauseHard();
    this.currentTime = 0;
    this.duration = 0;
    this.updateMediaSession(null);
    this.emit();
  }

  async toggle() {
    if (!this.current) return;
    if (this.remote) {
      if (this.playing) this.remote.pause();
      else this.remote.play();
      return;
    }
    if (this.outage) {
      // Nothing to play until the hub is back: remember the intent instead.
      this.outage.play = !this.outage.play;
      if (this.outage.play) toasts.info(t("core.player.waitingHub"), { key: "player-waiting-hub" });
      else this.pauseReason = "user";
      // The Android shell keeps CPU and network awake only while this wants to play.
      this.syncNativeIntent();
      this.emitPlayState();
      return;
    }
    if (this.crossfadeBusy) {
      // Space / play-pause mid-fade: settle the transition first, so the
      // button acts on what is heard (it used to pause only the outgoing
      // deck while the incoming one played on).
      const wasPlaying = this.playing;
      this.finalizeCrossfade();
      if (wasPlaying) {
        this.pauseLocalDecks();
        return;
      }
    }
    const a = this.activeAudio();
    // `playing` too: during a reconnect the deck is silent (reloading) while the
    // player still plays, and the button shows pause. Pressing it must pause,
    // not start the old element.
    if (this.playing || !a.paused || !this.inactiveDeck().paused) {
      this.pauseLocalDecks();
      return;
    }
    // A track is already loading to play (tapped a moment ago): nothing to add.
    if (this.autoplayPending()) return;
    if (a.error != null && a.getAttribute("src")) {
      // The element broke earlier (hub hiccup): play() would just fail again.
      await this.reloadCurrentAt(this.currentTime, true);
      return;
    }
    this.ensureFadeControl();
    try {
      // No graph (the usual case): nothing to wait for, play stays in the gesture.
      const resume = this.resumeGraphForPlay();
      if (resume) await resume;
      // Restored session with no source yet (e.g. the deck was reset).
      if (!a.src && this.current) a.src = mediaUrl(this.current.rel_path);
      await a.play();
    } catch (e) {
      this.playing = false;
      this.syncMediaPlaybackState();
      this.emitPlayState();
      this.reportPlayFailure(e);
    }
  }

  /** Superseded loads abort on purpose; anything else deserves a word. */
  private reportPlayFailure(e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    const key =
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "core.player.playBlocked"
        : "core.player.playFailed";
    toasts.error(t(key), { key: "player-play-failed" });
  }

  pause() {
    if (this.remote) {
      this.remote.pause();
      return;
    }
    if (this.crossfadeBusy) this.finalizeCrossfade();
    this.pauseLocalDecks();
  }

  /**
   * Silence both local decks. The active deck's `pause` event normally flips
   * the state; when it was not actually running (a play still pending) no
   * event comes, so the state is settled here.
   */
  private pauseLocalDecks() {
    const a = this.activeAudio();
    const wasSilent = a.paused;
    this.pauseGen += 1;
    this.expectPause("user");
    this.playRetry = false;
    const other = this.inactiveDeck();
    if (!other.paused) other.pause();
    a.pause();
    if (wasSilent && this.playing) {
      this.playing = false;
      this.syncMediaPlaybackState();
      this.persistPosition(true, true);
      this.emitPlayState();
    }
    // A pending load no longer means "about to play": tell the shell.
    this.syncNativeIntent();
  }

  private pauseHard() {
    // Queue emptied while casting: the receiver must stop too — the dock (and
    // its Cast button) goes away with the queue.
    this.remote?.pause();
    this.pauseGen += 1;
    this.expectPause("user");
    this.playRetry = false;
    this.deck0.pause();
    this.deck1.pause();
    this.playing = false;
  }

  async next() {
    if (!this.queue.length) return;
    // During an active crossfade, finish the swap (legacy) instead of skipping ahead.
    if (this.crossfadeBusy) {
      this.finalizeCrossfade();
      return;
    }
    this.cancelPendingLoad();
    this.abortCrossfade();
    if (this.index < this.queue.length - 1) this.index += 1;
    else if (this.repeat === "all") this.index = 0;
    else return;
    await this.loadCurrent(true);
  }

  async prev() {
    if (!this.queue.length) return;
    const wasFading = this.crossfadeBusy;
    this.cancelPendingLoad();
    this.abortCrossfade();
    const position = this.remote ? this.currentTime : this.activeAudio().currentTime;
    if (!wasFading && position > 3) {
      this.seek(0);
      return;
    }
    this.index = this.index > 0 ? this.index - 1 : 0;
    await this.loadCurrent(true);
  }

  /**
   * Cheap on purpose: dragging the timeline calls this dozens of times a
   * second. The UI value moves at once (progress emit only, no full state
   * emit); the element itself is seeked at most once per frame.
   */
  seek(seconds: number, opts?: { force?: boolean }) {
    if (!Number.isFinite(seconds)) return;
    // Seek lock (Plectr run): the timeline, media keys and shortcuts are
    // refused; code that owns the lock passes `{ force: true }`.
    if (!this.guards.allowSeek(opts)) return;
    // A live stream has no timeline.
    if (isLiveTrack(this.current)) return;
    const target = Math.max(0, seconds);
    this.currentTime = target;
    if (this.remote) {
      this.emitProgress();
      this.remote.seek(target);
      return;
    }
    this.pendingSeek = target;
    this.emitProgress();
    // Hidden pages get no animation frames (lock-screen seek): apply now.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.applyPendingSeek();
      return;
    }
    if (!this.seekFrame) {
      this.seekFrame = window.requestAnimationFrame(() => this.applyPendingSeek());
    }
  }

  private applyPendingSeek() {
    if (this.seekFrame) window.cancelAnimationFrame(this.seekFrame);
    this.seekFrame = 0;
    const target = this.pendingSeek;
    this.pendingSeek = null;
    if (target == null) return;
    // A user seek beats a queued restore of the previous session's position.
    this.restorePosition = null;
    try {
      this.activeAudio().currentTime = target;
    } catch {
      /* not seekable yet */
    }
    this.currentTime = target;
    this.syncMediaPosition(true);
    this.persistPosition();
  }

  /** Drop a queued seek: a new track starts from its own position. */
  private cancelPendingSeek() {
    if (this.seekFrame) window.cancelAnimationFrame(this.seekFrame);
    this.seekFrame = 0;
    this.pendingSeek = null;
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
      this.queueDirty = true;
      this.index = cur ? 0 : this.index;
    } else {
      this.queue = [...this.privateQueue];
      this.queueDirty = true;
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
    this.activeAudio().loop = this.repeat === "one" && !this.guards.held;
    this.emit();
  }

  setSleepTimer(minutes: number | null) {
    if (this.sleepTimeout) window.clearTimeout(this.sleepTimeout);
    if (this.sleepFadeTimer) window.clearTimeout(this.sleepFadeTimer);
    this.sleepTimeout = 0;
    this.sleepFadeTimer = 0;
    this.setMasterLevel(1);
    if (minutes == null || minutes <= 0) {
      this.sleepTimerEndsAt = null;
      this.emit();
      return;
    }
    const endsAt = Date.now() + minutes * 60_000;
    this.sleepTimerEndsAt = endsAt;
    const delay = Math.max(0, endsAt - Date.now() - SLEEP_FADE_MS);
    this.sleepTimeout = window.setTimeout(() => {
      this.sleepTimeout = 0;
      // Linear 30 s fade of the master level (GainNode or element volume).
      this.setMasterLevel(0, SLEEP_FADE_MS);
      this.sleepFadeTimer = window.setTimeout(() => {
        this.sleepFadeTimer = 0;
        // Land on silence even if the ticker lagged, pause while still
        // silent, then restore the level: the other order plays a few ms at
        // full volume right before stopping.
        this.setMasterLevel(0);
        this.pause();
        this.setSleepTimer(null);
      }, SLEEP_FADE_MS);
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

  /**
   * Resolves once `audio` can start: first data by default, or just metadata
   * (`HAVE_METADATA`) with `metadataEnough` — for tracks whose duration the
   * hub already knows, so a multi-hour file is not held up by buffering;
   * `play()` then starts as soon as data arrives. Never `canplaythrough`.
   */
  private waitForAudioReady(audio: HTMLAudioElement, timeoutMs = 4000, metadataEnough = false) {
    const minReady = metadataEnough
      ? HTMLMediaElement.HAVE_METADATA
      : HTMLMediaElement.HAVE_FUTURE_DATA;
    return new Promise<boolean>((resolve) => {
      if (audio.readyState >= minReady) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        audio.removeEventListener("loadedmetadata", onMetadata);
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("loadeddata", onReady);
        audio.removeEventListener("error", onFail);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onMetadata = () => {
        if (metadataEnough) finish(true);
      };
      const onFail = () => finish(false);
      const timer = window.setTimeout(
        () => finish(audio.error == null && audio.readyState >= minReady),
        timeoutMs,
      );
      audio.addEventListener("loadedmetadata", onMetadata, { once: true });
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("loadeddata", onReady, { once: true });
      audio.addEventListener("error", onFail, { once: true });
    });
  }

  /** The hub's scanned duration of `track`, in seconds (0 when unknown). */
  private knownDuration(track: Track | null | undefined): number {
    return track && track.duration_ms > 0 ? track.duration_ms / 1000 : 0;
  }

  /** The queued track `audio` is loaded with, if any. */
  private trackOnDeck(audio: HTMLAudioElement): Track | null {
    const src = audio.getAttribute("src");
    if (!src) return null;
    const cur = this.current;
    if (cur && mediaUrl(cur.rel_path) === src) return cur;
    return this.queue.find((t) => mediaUrl(t.rel_path) === src) ?? null;
  }

  /**
   * Seek-bar length for a deck: the hub's scanned duration when known. It is
   * exact (frame-counted for VBR MP3s without a Xing header), while the
   * element only estimates those from the bitrate — off by minutes on a long
   * DJ set — and reports nothing useful for a transcoded stream.
   */
  private deckDuration(audio: HTMLAudioElement, track?: Track | null): number {
    const known = this.knownDuration(track === undefined ? this.trackOnDeck(audio) : track);
    if (known > 0) return known;
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  }

  private inactiveDeck(): HTMLAudioElement {
    return this.active === 0 ? this.deck1 : this.deck0;
  }

  /**
   * The deck really holds `path`, buffered. `prefetchedRelPath` alone is only
   * a hint: it survives skips now (gapless), so the element is the authority.
   */
  private deckReadyWith(el: HTMLAudioElement, path: string): boolean {
    return (
      this.prefetchedRelPath === path &&
      el.getAttribute("src") === mediaUrl(path) &&
      this.audioReadyEnough(el)
    );
  }

  /**
   * Warm the inactive deck with the next track. With crossfade the fade
   * picks it up; without, `onEnded` → `loadCurrent` finds it buffered and
   * starts it at once instead of waiting for the network (gapless-ish).
   */
  private prefetchNextDeck() {
    if (this.repeat === "one" || this.crossfadeBusy || this.guards.held) return;
    const nextIdx = this.resolveNextIndex();
    if (nextIdx == null || nextIdx === this.index) return;
    const nextTr = this.queue[nextIdx];
    // A live stream is never opened ahead of time (it would start streaming).
    if (!nextTr || isLiveTrack(nextTr)) return;
    const out = this.activeAudio();
    const d = out.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const remain = d - out.currentTime;
    // Warm the next deck a bit before the fade window.
    const fade = this.effectiveCrossfadeSec;
    const lead = fade ? fade + CROSSFADE_PREFETCH_LEAD_SEC : GAPLESS_PREFETCH_SEC;
    if (remain > lead || remain < 0.2) return;
    const path = nextTr.rel_path;
    const inEl = this.inactiveDeck();
    if (this.deckReadyWith(inEl, path)) return;
    if (this.prefetchedRelPath !== path || inEl.getAttribute("src") !== mediaUrl(path)) {
      this.prefetchedRelPath = path;
      inEl.src = mediaUrl(path);
      inEl.load();
    }
  }

  private abortCrossfade() {
    this.crossfadeGen += 1;
    window.clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = 0;
    window.clearTimeout(this.crossfadeWatchdog);
    this.crossfadeWatchdog = 0;
    const wasBusy = this.crossfadeBusy;
    this.crossfadeBusy = false;
    this.crossfadeOutIx = null;
    this.crossfadeInIx = null;
    this.crossfadeNextIdx = null;
    // Not fading: the inactive deck still holds what was prefetched, and
    // `loadCurrent` reuses it when the next track is that one (gapless).
    if (!wasBusy) return;
    this.prefetchedRelPath = null;
    this.snapSolo(this.active);
    const inactive = this.inactiveDeck();
    inactive.pause();
    inactive.removeAttribute("src");
    void inactive.load();
    this.maybeDropGraph();
  }

  /** The upcoming transition already refused a crossfade (see crossfadeRefused). */
  private crossfadeRefusedNow(): boolean {
    const r = this.crossfadeRefused;
    if (!r) return false;
    const nextIdx = this.resolveNextIndex();
    const next = nextIdx == null ? null : this.queue[nextIdx];
    if (r.from === this.current?.rel_path && r.to === next?.rel_path) return true;
    this.crossfadeRefused = null;
    return false;
  }

  /** Invalidate in-flight dual-deck loads (next/prev/playTracks). */
  private cancelPendingLoad() {
    this.loadGen += 1;
  }

  private finalizeCrossfade() {
    if (!this.crossfadeBusy) return;
    window.clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = 0;
    window.clearTimeout(this.crossfadeWatchdog);
    this.crossfadeWatchdog = 0;

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
      this.duration = this.deckDuration(inEl, nextTr);
      this.currentTime = inEl.currentTime;
      this.playing = !inEl.paused;
      this.resetHalfListen(nextTr);
      this.pushRecentDeferred(nextTr);
      this.updateMediaSession(nextTr);
    }
    this.maybeDropGraph();
    this.emit();
    // The incoming track was shorter than the fade and is over already: its
    // `ended` went by while it was not the active deck, so advance now.
    if (nextTr && inEl.ended && this.playing) void this.onEnded();
  }

  /**
   * Watchdog: the crossfade did not complete on its own (incoming deck never
   * started, events lost, a pending resume). The player must never stay
   * mid-transition: finish it when the incoming deck really plays, otherwise
   * drop it and let the plain advance take over.
   */
  private rescueCrossfade(token: number) {
    if (token !== this.crossfadeGen || !this.crossfadeBusy) return;
    const inIx = this.crossfadeInIx;
    const inEl = inIx == null ? null : this.deckEl(inIx);
    if (inEl && !inEl.paused && !inEl.error && inEl.readyState >= 2) {
      this.finalizeCrossfade();
      return;
    }
    const outEl = this.activeAudio();
    const d = outEl.duration;
    const outDone = outEl.ended || !Number.isFinite(d) || d - outEl.currentTime < 0.5;
    const wasPlaying = this.playing;
    this.abortCrossfade();
    if (outDone && wasPlaying) void this.next();
  }

  /** Episodes and live streams start and end cleanly: no crossfade around them. */
  private crossfadeAllowedAround(): boolean {
    if (isExternalTrack(this.current)) return false;
    const nextIdx = this.resolveNextIndex();
    const next = nextIdx == null ? null : this.queue[nextIdx];
    return !isExternalTrack(next);
  }

  private maybeStartCrossfade() {
    const fade = this.effectiveCrossfadeSec;
    if (!fade || this.repeat === "one" || this.crossfadeBusy || this.guards.held) return;
    if (!this.crossfadeAllowedAround()) return;
    if (this.crossfadeRefusedNow()) return;
    const out = this.activeAudio();
    const d = out.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const remain = d - out.currentTime;
    if (remain > fade + 0.25 || remain < 0.08) return;
    void this.startCrossfade();
  }

  private async startCrossfade() {
    const fade = this.effectiveCrossfadeSec;
    if (!fade || this.crossfadeBusy || this.repeat === "one" || this.guards.held) return;
    if (!this.crossfadeAllowedAround()) return;
    const nextIdx = this.resolveNextIndex();
    if (nextIdx == null || nextIdx === this.index) return;
    const nextTr = this.queue[nextIdx];
    if (!nextTr) return;

    const outIx = this.active;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl = outIx === 0 ? this.deck0 : this.deck1;
    const inEl = inIx === 0 ? this.deck0 : this.deck1;

    const d = outEl.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const fadeWindow = Math.min(fade, d);
    if (outEl.currentTime < d - fadeWindow - 0.02) return;
    const remain = d - outEl.currentTime;
    if (remain < 0.08) return;

    if (this.crossfadeRefusedNow()) return;
    // Mark busy before any await (legacy-aligned) so timeupdate won't re-enter.
    this.crossfadeBusy = true;
    this.crossfadeOutIx = outIx;
    this.crossfadeInIx = inIx;
    this.crossfadeNextIdx = nextIdx;
    const token = this.crossfadeGen;
    window.clearTimeout(this.crossfadeWatchdog);
    this.crossfadeWatchdog = window.setTimeout(
      () => this.rescueCrossfade(token),
      fadeWindow * 1000 + CROSSFADE_WATCHDOG_EXTRA_MS,
    );

    // Reuse warm inactive deck when possible; otherwise bind now.
    // Never await canplay here — that ate the fade window and broke seamless.
    const path = nextTr.rel_path;
    const url = mediaUrl(path);
    if (this.prefetchedRelPath !== path || inEl.getAttribute("src") !== url) {
      inEl.src = url;
      inEl.load();
      this.prefetchedRelPath = path;
    }

    try {
      const resume = this.resumeGraphForPlay();
      if (resume) await resume;
      if (token !== this.crossfadeGen || !this.crossfadeBusy) return;
      try {
        inEl.currentTime = 0;
      } catch {
        /* ignore seek errors before metadata */
      }
      await inEl.play();
    } catch (e) {
      if (token !== this.crossfadeGen) return;
      // Never retry this transition as a crossfade (see crossfadeRefused);
      // a format the engine refuses goes to the transcoded stream next time.
      const from = this.current?.rel_path ?? "";
      this.crossfadeRefused = { from, to: path };
      if (e instanceof DOMException && e.name === "NotSupportedError") markNeedsTranscode(path);
      window.clearTimeout(this.crossfadeWatchdog);
      this.crossfadeWatchdog = 0;
      this.crossfadeBusy = false;
      this.crossfadeOutIx = null;
      this.crossfadeInIx = null;
      this.crossfadeNextIdx = null;
      this.snapSolo(outIx);
      inEl.pause();
      inEl.removeAttribute("src");
      void inEl.load();
      this.prefetchedRelPath = null;
      this.maybeDropGraph();
      return;
    }

    if (token !== this.crossfadeGen || !this.crossfadeBusy) return;

    const liveRemain = Math.max(0.05, outEl.duration - outEl.currentTime);
    if (!Number.isFinite(liveRemain) || outEl.ended || liveRemain < 0.05) {
      this.finalizeCrossfade();
      return;
    }
    const fadeLen = Math.min(fade, liveRemain);

    // Out → 0, in → 1, from wherever they are now: on the GainNodes when the
    // analyser graph is engaged, on the elements' volume otherwise.
    this.setDeckLevels(inIx === 0 ? [1, 0] : [0, 1], fadeLen * 1000);

    this.crossfadeTimer = window.setTimeout(() => {
      if (token !== this.crossfadeGen) return;
      this.finalizeCrossfade();
    }, fadeLen * 1000 + 40);
  }

  /**
   * Dual-deck load (legacy PlayerContext): keep the outgoing deck playing while
   * the incoming deck buffers, then snap gains / swap. Avoids the silence gap
   * from setting `src` on the active element and awaiting `play()`.
   */
  private async loadCurrent(autoplay: boolean) {
    // Holds deck references across awaits: no deck may be swapped meanwhile.
    this.deckOpsInFlight += 1;
    if (autoplay) {
      // Means to play from now on: with the screen locked right after a tap the
      // Android shell must not let the WebView sleep before the first sound.
      this.autoplayPauseGen = this.pauseGen;
      this.autoplayLoads += 1;
      this.syncNativeIntent();
    }
    try {
      await this.loadCurrentDecks(autoplay);
    } finally {
      this.deckOpsInFlight -= 1;
      if (autoplay) {
        this.autoplayLoads -= 1;
        this.syncNativeIntent();
      }
      this.maybeDropGraph();
    }
  }

  private async loadCurrentDecks(autoplay: boolean) {
    const track = this.current;
    if (!track) return;
    const gen = ++this.loadGen;
    const pauseGen = this.pauseGen;
    // Autoplay, unless a pause came in while the track loaded.
    const autoplayNow = () => autoplay && !this.pausedSince(pauseGen);
    // A fresh load: its own transition out gets a fresh crossfade attempt.
    this.crossfadeRefused = null;
    this.resetHalfListen(track);
    this.cancelPendingSeek();
    this.restorePosition = null;

    if (this.remote) {
      // Remote output: state and events only, the receiver does the playing.
      // An episode's resume point applies there too (and is consumed, so it
      // never fires on a later local load).
      const startAt = this.takeStartAt(track.rel_path);
      this.currentTime = startAt;
      this.duration = track.duration_ms > 0 ? track.duration_ms / 1000 : 0;
      this.playing = autoplay;
      this.syncMediaPlaybackState();
      this.updateMediaSession(track);
      if (autoplay) this.pushRecentDeferred(track);
      this.emit();
      this.emitProgress();
      this.remote.loadTrack(track, startAt, autoplay);
      return;
    }

    this.ensureFadeControl();
    const outIx = this.active;
    const inIx: DeckIx = outIx === 0 ? 1 : 0;
    const outEl = outIx === 0 ? this.deck0 : this.deck1;
    const inEl = inIx === 0 ? this.deck0 : this.deck1;
    const url = mediaUrl(track.rel_path);
    const path = track.rel_path;

    this.heldEndedFlag = false;
    this.playRetry = false;
    if (!autoplay) {
      // Prepared paused: nothing of the previous track may keep sounding
      // while the new one buffers.
      this.expectPause("user");
      outEl.pause();
      if (this.playing) {
        this.playing = false;
        this.syncMediaPlaybackState();
        this.emitPlayState();
      }
    }

    // Kick off buffering before UI/graph work so the click path stays lean.
    const alreadyBuffered = this.deckReadyWith(inEl, path);
    if (!alreadyBuffered) {
      this.prefetchedRelPath = path;
      inEl.src = url;
      inEl.load();
    }

    this.currentTime = 0;
    this.duration =
      track.duration_ms > 0 ? track.duration_ms / 1000 : this.duration;
    this.emit();
    this.emitProgress();
    // Media session + cover prefetch are non-critical for start latency.
    window.setTimeout(() => {
      if (gen === this.loadGen) this.updateMediaSession(track);
    }, 0);

    if (!alreadyBuffered) {
      // Known duration: the seek bar is already right, metadata is enough.
      const ready = await this.waitForAudioReady(inEl, 8000, this.knownDuration(track) > 0);
      if (gen !== this.loadGen) return;
      if (!ready && inEl.error != null) {
        // The file would not load (missing, unreadable, hub gone).
        this.prefetchedRelPath = null;
        await this.onTrackFailed(track, autoplay, 0, inEl.error.code);
        return;
      }
      if (!ready) {
        // Last resort: load on the active deck (may gap) so playback isn't stuck.
        outEl.loop = this.repeat === "one";
        outEl.src = url;
        if (autoplayNow()) {
          try {
            const resume = this.resumeGraphForPlay();
            if (resume) await resume;
            if (gen !== this.loadGen || !autoplayNow()) return;
            await outEl.play();
            this.playing = true;
            this.pushRecentDeferred(track);
          } catch (e) {
            this.playing = false;
            if (gen === this.loadGen) this.onAutoplayFailed(e);
          }
        }
        this.emit();
        return;
      }
    }

    if (gen !== this.loadGen) return;

    inEl.loop = this.repeat === "one" && !this.guards.held && !isLiveTrack(track);
    // Resume point of an episode, else the top. Only seek a deck that is
    // elsewhere: a needless seek restarts the request.
    const startAt = this.takeStartAt(path);
    if (inEl.currentTime !== startAt) {
      try {
        inEl.currentTime = startAt;
      } catch {
        /* ignore */
      }
    }

    const resume = this.resumeGraphForPlay();
    if (resume) await resume;
    if (gen !== this.loadGen) return;

    this.snapSolo(inIx);
    this.active = inIx;

    const length = this.deckDuration(inEl, track);
    if (length > 0) this.duration = length;
    this.currentTime = inEl.currentTime;

    if (autoplayNow()) {
      try {
        await inEl.play();
        if (gen !== this.loadGen) return;
        outEl.pause();
        outEl.removeAttribute("src");
        void outEl.load();
        this.playing = true;
        this.pushRecentDeferred(track);
        this.updateMediaSession(track);
      } catch (e) {
        if (gen !== this.loadGen) return;
        this.playing = false;
        this.onAutoplayFailed(e);
      }
    } else {
      outEl.pause();
      outEl.removeAttribute("src");
      void outEl.load();
    }
    this.prefetchedRelPath = path;
    this.emit();
    this.emitProgress();
  }

  /** Where the next load of `relPath` starts (an episode's resume point). */
  private startAtNext: { relPath: string; time: number } | null = null;

  private takeStartAt(relPath: string): number {
    const s = this.startAtNext;
    this.startAtNext = null;
    return s && s.relPath === relPath && s.time > 0 ? s.time : 0;
  }

  /**
   * Play a podcast episode / live stream (an external item). It goes right
   * after the current item and starts now, so the rest of the queue carries
   * on after it; `queue: true` only adds it (after the manual "add to
   * queue" items). `startAt` resumes an episode where it was left.
   */
  playExternal(track: Track, opts: { startAt?: number; queue?: boolean } = {}) {
    if (!isExternalTrack(track)) return;
    if (opts.queue) {
      this.addToQueue(track);
      return;
    }
    const startAt =
      !isLiveTrack(track) && opts.startAt && opts.startAt > 0 ? opts.startAt : 0;
    const existing = this.queue.findIndex((t) => t.rel_path === track.rel_path);
    if (existing >= 0) {
      if (existing === this.index && this.current) {
        if (startAt > 0) this.seek(startAt, { force: true });
        if (!this.playing) void this.toggle();
        return;
      }
      this.startAtNext = startAt > 0 ? { relPath: track.rel_path, time: startAt } : null;
      this.playQueueIndex(existing);
      return;
    }
    this.startAtNext = startAt > 0 ? { relPath: track.rel_path, time: startAt } : null;
    if (!this.queue.length || this.index < 0) {
      this.playSequence([track], 0);
      return;
    }
    this.cancelPendingLoad();
    this.abortCrossfade();
    const at = Math.min(this.index + 1, this.queue.length);
    this.queue = [...this.queue.slice(0, at), track, ...this.queue.slice(at)];
    const privAt = this.privateQueue.findIndex((t) => t.rel_path === this.current?.rel_path);
    this.privateQueue =
      privAt >= 0
        ? [...this.privateQueue.slice(0, privAt + 1), track, ...this.privateQueue.slice(privAt + 1)]
        : [...this.privateQueue, track];
    this.queueDirty = true;
    this.index = at;
    void this.loadCurrent(true);
  }

  /** True while a live stream is the current item (no seek, no duration). */
  get currentIsLive(): boolean {
    return isLiveTrack(this.current);
  }

  private async onEnded() {
    if (!this.guards.advanceOnEnd()) {
      this.finishHeldTrack();
      return;
    }
    if (this.repeat === "one") return;
    if (this.index < this.queue.length - 1 || this.repeat === "all") {
      await this.next();
    } else {
      this.pauseReason = "ended";
      this.playing = false;
      this.syncMediaPlaybackState();
      this.emit();
    }
  }

  private shuffled(list: Track[]) {
    return buildSmartRandomQueue(list, {
      recentRelPaths: new Set(getRecentRelPaths()),
    });
  }

  /** Albums whose cover was warmed already (one request per album, not per call). */
  private warmedCovers = new Set<string>();

  private prefetchQueueCovers() {
    for (const t of this.queue.slice(this.index + 1, this.index + 6)) {
      // The shade and the dock both show the 256 variant: warm that one.
      const url = coverUrlFor(t, 256);
      if (!url || this.warmedCovers.has(url)) continue;
      if (this.warmedCovers.size > 400) this.warmedCovers.clear();
      this.warmedCovers.add(url);
      const img = new Image();
      img.src = url;
    }
  }

  /** Track + transport state for the lock screen / notification shade. */
  private updateMediaSession(track: Track | null) {
    if (!track) {
      setMediaSessionMetadata(null);
      setMediaSessionPlaybackState("none");
      clearMediaSessionPosition();
      return;
    }
    const external = isExternalTrack(track);
    setMediaSessionMetadata({
      title: track.title,
      artist: track.artist_name,
      album: external ? (track.external?.sourceName ?? track.album_name) : track.album_name,
      albumId: track.album_id,
      hasCover: coverUrlFor(track) != null,
      coverVersion: track.cover_version ?? null,
      artworkUrl: external ? coverUrlFor(track, 256) : null,
    });
    setMediaSessionPlaybackState(this.playing ? "playing" : "paused");
    this.syncMediaPosition(true);
    this.prefetchQueueCovers();
  }

  private syncMediaPlaybackState() {
    this.syncNativeIntent();
    if (!this.current) {
      setMediaSessionPlaybackState("none");
      return;
    }
    setMediaSessionPlaybackState(this.playing ? "playing" : "paused");
    this.syncMediaPosition(true);
  }

  private syncMediaPosition(force = false) {
    if (!this.current) return;
    const now = Date.now();
    if (!force && now - this.lastMediaPositionAt < MEDIA_POSITION_REFRESH_MS) {
      return;
    }
    this.lastMediaPositionAt = now;
    setMediaSessionPosition(this.duration, this.currentTime, 1);
  }
}

export const player = new PlayerController();

export function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ss = s.toString().padStart(2, "0");
  // Long DJ sets: "6:00:00" reads better than "360:00".
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
