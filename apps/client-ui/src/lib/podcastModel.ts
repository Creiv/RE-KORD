/**
 * Podcasts module, pure part (no stores, no DOM: tested in node).
 *
 * - The shapes `/api/v1/podcasts` answers with.
 * - The per-account listening state kept in the hub user-state
 *   (`settings.podcasts`): resume position and "listened" per episode, the
 *   last `MAX_ENTRIES` only, merged entry by entry across devices.
 * - What an episode row shows (progress, resume point, listened).
 */

export type PodcastEpisode = {
  key: string;
  title: string;
  publishedAt?: string | null;
  durationSecs?: number | null;
  hasArt?: boolean;
  mime?: string | null;
  live?: boolean;
};

export type PodcastSource = {
  id: number;
  name: string;
  kind: "rss" | "rtl" | "ytdlp" | "live";
  live: boolean;
  episodeCount: number;
  hasArt: boolean;
  fetchedAt: string | null;
  /** Code of the last failed fetch (episodes may still be the previous ones). */
  error: string | null;
  episodes: PodcastEpisode[];
};

export type PodcastList = { sources: PodcastSource[]; cacheTtlMinutes?: number };

/** One episode's listening state (short keys: it lives in the user state). */
export type PodcastEntry = {
  /** Position, seconds. */
  p: number;
  /** Duration, seconds (0 = unknown). */
  d: number;
  /** Listened to the end (or marked so). */
  l: boolean;
  /** Last change, ms since epoch (newest wins on merge). */
  at: number;
  /** Title and source name, for the history ("Recenti"). */
  t: string;
  s: string;
  /** Source id (the key already has it, kept for convenience). */
  sid: number;
  /** Episode key. */
  k: string;
  /** The hub has artwork for it. */
  a?: boolean;
  /** Live stream (no position). */
  live?: boolean;
};

export type PodcastState = { v: 1; e: Record<string, PodcastEntry> };

/** Entries kept per account (oldest dropped first). */
export const MAX_ENTRIES = 200;
/** Closer than this to the end counts as listened. */
export const LISTENED_TAIL_SEC = 30;
/** Below this, playing again starts from the top. */
export const RESUME_MIN_SEC = 15;

export const SETTING_KEY = "podcasts";

export function entryId(sourceId: number, key: string): string {
  return `${sourceId}:${key}`;
}

export function emptyState(): PodcastState {
  return { v: 1, e: {} };
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read whatever the user state holds; drops malformed entries. */
export function normalizeState(raw: unknown): PodcastState {
  const out = emptyState();
  if (!raw || typeof raw !== "object") return out;
  const e = (raw as { e?: unknown }).e;
  if (!e || typeof e !== "object") return out;
  for (const [id, v] of Object.entries(e as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const x = v as Record<string, unknown>;
    const m = /^(\d+):([A-Za-z0-9_]{1,32})$/.exec(id);
    if (!m) continue;
    out.e[id] = {
      p: num(x.p),
      d: num(x.d),
      l: x.l === true,
      at: num(x.at),
      t: typeof x.t === "string" ? x.t.slice(0, 300) : "",
      s: typeof x.s === "string" ? x.s.slice(0, 120) : "",
      sid: Number(m[1]),
      k: m[2]!,
      ...(x.a === true ? { a: true } : {}),
      ...(x.live === true ? { live: true } : {}),
    };
  }
  return capEntries(out);
}

/** Keep the newest `max` entries. */
export function capEntries(state: PodcastState, max = MAX_ENTRIES): PodcastState {
  const ids = Object.keys(state.e);
  if (ids.length <= max) return state;
  const keep = ids.sort((a, b) => state.e[b]!.at - state.e[a]!.at).slice(0, max);
  const e: Record<string, PodcastEntry> = {};
  for (const id of keep) e[id] = state.e[id]!;
  return { v: 1, e };
}

/** Per entry, the newest change wins (another device may have moved on). */
export function mergeStates(a: unknown, b: unknown): PodcastState {
  const x = normalizeState(a);
  const y = normalizeState(b);
  const e: Record<string, PodcastEntry> = { ...x.e };
  for (const [id, entry] of Object.entries(y.e)) {
    const cur = e[id];
    if (!cur || entry.at > cur.at) e[id] = entry;
  }
  return capEntries({ v: 1, e });
}

export type EntryMeta = {
  sourceId: number;
  key: string;
  title: string;
  sourceName: string;
  art?: boolean;
  live?: boolean;
};

/** Whether `pos` of `dur` means "heard to the end". */
export function reachedEnd(pos: number, dur: number): boolean {
  if (!(dur > 0)) return false;
  return pos >= dur - LISTENED_TAIL_SEC || pos >= dur * 0.97;
}

/** A new position for an episode (listened once it reaches the end). */
export function recordProgress(
  state: PodcastState,
  meta: EntryMeta,
  pos: number,
  dur: number,
  now = Date.now(),
): PodcastState {
  const id = entryId(meta.sourceId, meta.key);
  const prev = state.e[id];
  const d = dur > 0 ? dur : (prev?.d ?? 0);
  const p = meta.live ? 0 : Math.max(0, Math.round(pos));
  const listened = (prev?.l ?? false) || (!meta.live && reachedEnd(p, d));
  const next: PodcastEntry = {
    p: listened && reachedEnd(p, d) ? 0 : p,
    d: Math.round(d),
    l: listened,
    at: now,
    t: meta.title,
    s: meta.sourceName,
    sid: meta.sourceId,
    k: meta.key,
    ...(meta.art ? { a: true } : {}),
    ...(meta.live ? { live: true } : {}),
  };
  return capEntries({ v: 1, e: { ...state.e, [id]: next } });
}

/** Mark (or unmark) as listened; the resume point goes either way. */
export function markListened(
  state: PodcastState,
  meta: EntryMeta,
  listened: boolean,
  now = Date.now(),
): PodcastState {
  const id = entryId(meta.sourceId, meta.key);
  const prev = state.e[id];
  const next: PodcastEntry = {
    p: 0,
    d: prev?.d ?? 0,
    l: listened,
    at: now,
    t: meta.title || prev?.t || "",
    s: meta.sourceName || prev?.s || "",
    sid: meta.sourceId,
    k: meta.key,
    ...(meta.art || prev?.a ? { a: true } : {}),
  };
  return capEntries({ v: 1, e: { ...state.e, [id]: next } });
}

export type EpisodeProgress = {
  /** 0..1, 0 when unknown / not started. */
  ratio: number;
  listened: boolean;
  /** Where "play" resumes (seconds), 0 = from the top. */
  resumeAt: number;
  started: boolean;
};

export function episodeProgress(
  entry: PodcastEntry | null | undefined,
  durationSecs?: number | null,
): EpisodeProgress {
  if (!entry || entry.live) return { ratio: 0, listened: false, resumeAt: 0, started: false };
  const d = durationSecs && durationSecs > 0 ? durationSecs : entry.d;
  const resumeAt =
    !entry.l && entry.p >= RESUME_MIN_SEC && !(d > 0 && entry.p >= d - RESUME_MIN_SEC)
      ? entry.p
      : 0;
  const ratio = entry.l ? 1 : d > 0 ? Math.min(1, entry.p / d) : 0;
  return { ratio, listened: entry.l, resumeAt, started: entry.p > 0 || entry.l };
}

/** An episode of a source left halfway, still in its list. */
export type Resumable = { ep: PodcastEpisode; resumeAt: number };

/**
 * The episode of `source` to offer "continue" for: started, not finished
 * (there is a resume point), still among the episodes the hub lists (only
 * those can be played); the most recently listened one wins.
 */
export function resumableEpisode(state: PodcastState, source: PodcastSource): Resumable | null {
  if (source.live) return null;
  let best: (Resumable & { at: number }) | null = null;
  for (const ep of source.episodes) {
    const entry = state.e[entryId(source.id, ep.key)];
    if (!entry) continue;
    const { resumeAt } = episodeProgress(entry, ep.durationSecs);
    if (resumeAt > 0 && (!best || entry.at > best.at)) best = { ep, resumeAt, at: entry.at };
  }
  return best && { ep: best.ep, resumeAt: best.resumeAt };
}

/**
 * What a click on a source in the dashboard card does: a live station
 * plays; a show with an unfinished episode asks "continue?"; any other
 * opens its page (nothing starts by itself).
 */
export type CardAction = { kind: "live" } | ({ kind: "ask" } & Resumable) | { kind: "open" };

export function cardAction(state: PodcastState, source: PodcastSource): CardAction {
  if (source.live) return { kind: "live" };
  const r = resumableEpisode(state, source);
  return r ? { kind: "ask", ...r } : { kind: "open" };
}

/** `4:07`, `1:02:05`; empty when unknown. */
export function formatDuration(secs: number | null | undefined): string {
  if (!secs || !Number.isFinite(secs) || secs <= 0) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Minutes left of a started episode (null when not meaningful). */
export function minutesLeft(entry: PodcastEntry | null | undefined, durationSecs?: number | null): number | null {
  if (!entry || entry.l || entry.live) return null;
  const d = durationSecs && durationSecs > 0 ? durationSecs : entry.d;
  if (!(d > 0) || entry.p < RESUME_MIN_SEC) return null;
  return Math.max(1, Math.round((d - entry.p) / 60));
}

/** Sources worth showing: those with episodes or an error to report. */
export function visibleSources(list: readonly PodcastSource[]): PodcastSource[] {
  return list.filter((s) => s.episodes.length > 0 || s.error);
}

/** Rows of a source, limited to what the card shows. */
export function episodesFor(source: PodcastSource, limit?: number): PodcastEpisode[] {
  const n = limit ?? source.episodeCount;
  return source.episodes.slice(0, Math.max(1, n));
}

/** Episodes published less than this long ago get the "Nuovo" badge. */
export const NEW_EPISODE_MS = 2 * 3600 * 1000;

export function isNewEpisode(ep: Pick<PodcastEpisode, "publishedAt" | "live">, now = Date.now()): boolean {
  if (ep.live || !ep.publishedAt) return false;
  const t = Date.parse(ep.publishedAt);
  return Number.isFinite(t) && now - t >= -5 * 60_000 && now - t < NEW_EPISODE_MS;
}

export type SourceEpisode = { source: PodcastSource; ep: PodcastEpisode };

/**
 * "Ultimi": the newest episodes across sources, newest first, at most
 * `perSource` from one source (a busy hourly bulletin must not fill the list).
 * Live sources are left out (they are shown as radio tiles).
 */
export function latestAcross(
  sources: readonly PodcastSource[],
  perSource = 3,
  limit = 12,
): SourceEpisode[] {
  const all: SourceEpisode[] = [];
  for (const source of sources) {
    if (source.live) continue;
    for (const ep of episodesFor(source).slice(0, perSource)) all.push({ source, ep });
  }
  const time = (x: SourceEpisode) => {
    const t = x.ep.publishedAt ? Date.parse(x.ep.publishedAt) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  return all.sort((a, b) => time(b) - time(a)).slice(0, limit);
}

/** The tab to show: a remembered source when it still exists, else "latest" (or the only source). */
export function resolveTab(stored: string | null | undefined, sources: readonly PodcastSource[]): string {
  if (sources.length === 1) return String(sources[0]!.id);
  if (stored && stored !== "latest" && sources.some((s) => String(s.id) === stored)) return stored;
  return "latest";
}

/** Key of the single item of a live source (hub `LIVE_KEY`). */
export const LIVE_EPISODE_KEY = "live";
