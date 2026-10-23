/** Achievement / XP — lightweight port of src/lib/achievements.ts for the next client-ui.
 *  Badge texts are i18n keys (`achievements.badge.<id>.title|desc`, locales/plectr). */

import { normalizeGenreKey } from "./genres";

export type AchievementIconKind =
  | "play"
  | "heart"
  | "list"
  | "artist"
  | "genre"
  | "shuffle"
  | "library"
  | "flame"
  | "streak"
  | "plectr";

export type AchievementSignals = {
  totalPlays: number;
  favoritesCount: number;
  playlistsCount: number;
  artistsWithPlays: number;
  genresWithPlays: number;
  tracksWithPlays: number;
  shuffleBlocks: number;
  libraryTrackCount: number;
  /** Distinct artists / albums / genres in the library, when the caller knows them. */
  libraryArtistCount?: number;
  libraryAlbumCount?: number;
  libraryGenreCount?: number;
  topArtistPlays: number;
  topTrackPlays: number;
  albumsWithPlays: number;
  playlistTrackCount: number;
  streak: number;
  plectrTracksPlayed: number;
  /** Plectr career (K4 `selectPlectrCareer`): full combos / all perfects / XP. */
  plectrFullCombos: number;
  plectrAllPerfects: number;
  plectrXp: number;
};

/**
 * What a badge needs from the library before it can count (GitHub issue
 * #100): a 20-track library unlocked "half the library played" after ten
 * plays. `tracks` compares with the library size, the others with how many
 * distinct artists / albums / genres the library has (when known).
 */
export type LibraryMinimum = { kind: "tracks" | "artists" | "albums" | "genres"; need: number };

/** Title / description live in i18n: `achievements.badge.<id>.title|desc`. */
type AchievementDefinition = {
  id: string;
  xpBonus: number;
  icon: AchievementIconKind;
  check: (s: AchievementSignals) => boolean;
  /** Where the account stands: `[value, target]`, for the progress line. */
  progress: (s: AchievementSignals) => [number, number];
  minLibrary?: LibraryMinimum;
};

/** `signal >= n`. */
type CountedSignal = {
  [K in keyof AchievementSignals]-?: undefined extends AchievementSignals[K] ? never : K;
}[keyof AchievementSignals];

function at(
  id: string,
  xpBonus: number,
  icon: AchievementIconKind,
  field: CountedSignal,
  n: number,
  extra: { minLibrary?: LibraryMinimum } = {},
): AchievementDefinition {
  return {
    id,
    xpBonus,
    icon,
    check: (s) => s[field] >= n,
    progress: (s) => [Math.min(s[field], n), n],
    ...extra,
  };
}

/** A share of the library played, counted only on libraries of `minTracks` or more. */
function libraryPct(
  id: string,
  xpBonus: number,
  icon: AchievementIconKind,
  pct: number,
  minTracks: number,
): AchievementDefinition {
  const target = (s: AchievementSignals) => Math.max(1, Math.ceil(s.libraryTrackCount * pct));
  return {
    id,
    xpBonus,
    icon,
    check: (s) => libraryPctPlayed(s, pct),
    progress: (s) => [Math.min(s.tracksWithPlays, target(s)), target(s)],
    minLibrary: { kind: "tracks", need: minTracks },
  };
}

/** How many of the minimum's kind the library has (`null`: unknown, no gate). */
function libraryHas(s: AchievementSignals, kind: LibraryMinimum["kind"]): number | null {
  switch (kind) {
    case "tracks":
      return s.libraryTrackCount;
    case "artists":
      return s.libraryArtistCount ?? null;
    case "albums":
      return s.libraryAlbumCount ?? null;
    case "genres":
      return s.libraryGenreCount ?? null;
  }
}

type XpTier = { xpMin: number; xpMax: number | null; title: string };

const XP_TIERS: XpTier[] = [
  { title: "KICKER", xpMin: 0, xpMax: 99 },
  { title: "KRAFTER", xpMin: 100, xpMax: 299 },
  { title: "KURATORE", xpMin: 300, xpMax: 599 },
  { title: "KEEPER OF RE-KORD", xpMin: 600, xpMax: 999 },
  { title: "KONDUCTOR", xpMin: 1000, xpMax: 1499 },
  { title: "KOMPONER", xpMin: 1500, xpMax: 2199 },
  { title: "KREATOR", xpMin: 2200, xpMax: 2999 },
  { title: "KONTROLLER", xpMin: 3000, xpMax: 3999 },
  { title: "RE-KORDMASTER", xpMin: 4000, xpMax: 5499 },
  { title: "KING OF RE-KORD", xpMin: 5500, xpMax: null },
];

const TITLES = XP_TIERS.map((t) => t.title);
const LEVEL_XP_SCALE = 1.25;

function tierSpan(tier: XpTier, prevSpan: number): number {
  if (tier.xpMax != null) return tier.xpMax - tier.xpMin + 1;
  return prevSpan;
}

function buildNumericLevelXpMins(): number[] {
  const mins: number[] = [];
  let prevSpan = 100;
  for (const tier of XP_TIERS) {
    const span = tierSpan(tier, prevSpan);
    prevSpan = span;
    const half = Math.floor(span / 2);
    mins.push(tier.xpMin, tier.xpMin + half);
  }
  return mins;
}

const NUMERIC_LEVEL_XP_MINS = buildNumericLevelXpMins();
const POST_TITLE_LEVEL_SPAN = Math.floor(
  (XP_TIERS[8]!.xpMax! - XP_TIERS[8]!.xpMin + 1) / 2,
);

function scaledLevelXp(xp: number): number {
  return Math.ceil(xp * LEVEL_XP_SCALE);
}

function scaledPostTitleLevelSpan(): number {
  return Math.ceil(POST_TITLE_LEVEL_SPAN * LEVEL_XP_SCALE);
}

export function titleForNumericLevel(level: number): string {
  const idx = Math.min(TITLES.length - 1, Math.floor((level - 1) / 3));
  return TITLES[idx]!;
}

function numericLevelForXp(xp: number): number {
  const kingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[18]!);
  const postKingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[19]!);
  const postSpan = scaledPostTitleLevelSpan();
  if (xp >= postKingMin) {
    return 20 + Math.floor((xp - postKingMin) / postSpan);
  }
  if (xp >= kingMin) return 19;
  for (let i = NUMERIC_LEVEL_XP_MINS.length - 2; i >= 0; i--) {
    if (xp >= scaledLevelXp(NUMERIC_LEVEL_XP_MINS[i]!)) return i + 1;
  }
  return 1;
}

function xpMinForNumericLevel(level: number): number {
  if (level <= 20) return scaledLevelXp(NUMERIC_LEVEL_XP_MINS[level - 1]!);
  const postKingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[19]!);
  return postKingMin + (level - 20) * scaledPostTitleLevelSpan();
}

function xpMaxForNumericLevel(level: number): number {
  return xpMinForNumericLevel(level + 1) - 1;
}

function libraryPctPlayed(signals: AchievementSignals, pct: number): boolean {
  if (signals.libraryTrackCount <= 0) return false;
  const need = Math.max(1, Math.ceil(signals.libraryTrackCount * pct));
  return signals.tracksWithPlays >= need;
}

const DEFINITIONS: AchievementDefinition[] = [
  at("first_play", 10, "play", "totalPlays", 1),
  at("plays_10", 15, "play", "totalPlays", 10),
  at("plays_25", 20, "play", "totalPlays", 25),
  at("plays_50", 30, "play", "totalPlays", 50),
  at("plays_100", 50, "play", "totalPlays", 100),
  at("plays_250", 75, "play", "totalPlays", 250),
  at("plays_500", 100, "flame", "totalPlays", 500),
  at("plays_1000", 150, "flame", "totalPlays", 1000),
  at("plays_2500", 200, "flame", "totalPlays", 2500),
  at("plays_5000", 300, "flame", "totalPlays", 5000),
  at("first_favorite", 15, "heart", "favoritesCount", 1),
  at("favorites_5", 25, "heart", "favoritesCount", 5),
  at("favorites_10", 40, "heart", "favoritesCount", 10),
  at("favorites_25", 60, "heart", "favoritesCount", 25),
  at("favorites_50", 90, "heart", "favoritesCount", 50),
  at("favorites_100", 120, "heart", "favoritesCount", 100),
  at("playlist_1", 30, "list", "playlistsCount", 1),
  at("playlists_3", 50, "list", "playlistsCount", 3),
  at("playlists_5", 70, "list", "playlistsCount", 5),
  at("playlists_10", 100, "list", "playlistsCount", 10),
  at("playlists_20", 140, "list", "playlistsCount", 20),
  at("artists_3", 20, "artist", "artistsWithPlays", 3, { minLibrary: { kind: "artists", need: 6 } }),
  at("artists_5", 30, "artist", "artistsWithPlays", 5, { minLibrary: { kind: "artists", need: 10 } }),
  at("artists_10", 45, "artist", "artistsWithPlays", 10, { minLibrary: { kind: "artists", need: 20 } }),
  at("artists_20", 70, "artist", "artistsWithPlays", 20, { minLibrary: { kind: "artists", need: 40 } }),
  at("artists_50", 110, "artist", "artistsWithPlays", 50, { minLibrary: { kind: "artists", need: 100 } }),
  at("artists_100", 160, "artist", "artistsWithPlays", 100, { minLibrary: { kind: "artists", need: 200 } }),
  at("genres_3", 25, "genre", "genresWithPlays", 3, { minLibrary: { kind: "genres", need: 6 } }),
  at("genres_5", 40, "genre", "genresWithPlays", 5, { minLibrary: { kind: "genres", need: 10 } }),
  at("genres_10", 60, "genre", "genresWithPlays", 10, { minLibrary: { kind: "genres", need: 20 } }),
  at("genres_15", 80, "genre", "genresWithPlays", 15, { minLibrary: { kind: "genres", need: 30 } }),
  at("genres_20", 100, "genre", "genresWithPlays", 20, { minLibrary: { kind: "genres", need: 40 } }),
  at("tracks_10", 20, "library", "tracksWithPlays", 10, { minLibrary: { kind: "tracks", need: 50 } }),
  at("tracks_50", 50, "library", "tracksWithPlays", 50, { minLibrary: { kind: "tracks", need: 250 } }),
  at("tracks_100", 80, "library", "tracksWithPlays", 100, { minLibrary: { kind: "tracks", need: 500 } }),
  at("tracks_500", 150, "library", "tracksWithPlays", 500, { minLibrary: { kind: "tracks", need: 2500 } }),
  at("shuffle_1", 15, "shuffle", "shuffleBlocks", 1),
  at("shuffle_3", 25, "shuffle", "shuffleBlocks", 3),
  at("shuffle_5", 40, "shuffle", "shuffleBlocks", 5),
  at("shuffle_10", 60, "shuffle", "shuffleBlocks", 10),
  at("shuffle_25", 90, "shuffle", "shuffleBlocks", 25),
  at("artist_plays_10", 35, "artist", "topArtistPlays", 10),
  at("artist_plays_25", 80, "flame", "topArtistPlays", 25),
  at("artist_plays_50", 120, "flame", "topArtistPlays", 50),
  at("artist_plays_100", 180, "flame", "topArtistPlays", 100),
  libraryPct("library_5pct", 40, "library", 0.05, 200),
  libraryPct("library_10pct", 100, "library", 0.1, 300),
  libraryPct("library_25pct", 160, "library", 0.25, 500),
  libraryPct("library_50pct", 250, "library", 0.5, 1000),
  at("streak_3", 25, "streak", "streak", 3),
  at("streak_7", 50, "streak", "streak", 7),
  at("streak_14", 90, "streak", "streak", 14),
  at("streak_30", 150, "streak", "streak", 30),
  at("plays_7500", 400, "flame", "totalPlays", 7500),
  at("favorites_200", 200, "heart", "favoritesCount", 200),
  at("albums_10", 55, "library", "albumsWithPlays", 10, { minLibrary: { kind: "albums", need: 20 } }),
  at("albums_50", 110, "library", "albumsWithPlays", 50, { minLibrary: { kind: "albums", need: 100 } }),
  at("playlist_tracks_30", 85, "list", "playlistTrackCount", 30),
  at("track_plays_20", 70, "play", "topTrackPlays", 20),
  libraryPct("library_75pct", 320, "library", 0.75, 2000),
  at("plectr_tracks_10", 30, "plectr", "plectrTracksPlayed", 10),
  at("plectr_tracks_50", 55, "plectr", "plectrTracksPlayed", 50),
  at("plectr_tracks_100", 85, "plectr", "plectrTracksPlayed", 100),
  at("plectr_tracks_250", 130, "plectr", "plectrTracksPlayed", 250),
  at("plectr_tracks_500", 200, "plectr", "plectrTracksPlayed", 500),
];

export function achievementTitleKey(id: string): string {
  return `achievements.badge.${id}.title`;
}

export function achievementDescKey(id: string): string {
  return `achievements.badge.${id}.desc`;
}

/** Every badge id, in display order (lets tests check the i18n tables). */
export const ACHIEVEMENT_IDS: readonly string[] = DEFINITIONS.map((d) => d.id);

const STREAK_KEY = "rekord-achievements-streak";

/**
 * Hub user-state setting that carries the streak between devices and across
 * reinstalls (GitHub issue #100: kept only in `localStorage`, a new package or
 * a cleared WebView reset it). The local copy stays as a cache and for the
 * time before the account state arrives; the two are merged on every read.
 */
export const STREAK_SETTING_KEY = "listeningStreak";

export type StreakState = { count: number; lastDate: string };

/** How the streak reaches the synced settings; set once by the session layer. */
type StreakSync = {
  get: () => unknown;
  set: (state: StreakState) => void;
};

let streakSync: StreakSync | null = null;

export function setStreakSync(sync: StreakSync | null) {
  streakSync = sync;
}

export function normalizeStreakState(raw: unknown): StreakState {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<StreakState>;
  return {
    count:
      typeof parsed.count === "number" && Number.isFinite(parsed.count) && parsed.count >= 0
        ? Math.floor(parsed.count)
        : 0,
    lastDate: typeof parsed.lastDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.lastDate) ? parsed.lastDate : "",
  };
}

/**
 * Two copies of the streak (this device and the hub, or two devices): the
 * more recent day wins; the same day keeps the higher count; a copy from
 * the day before extends into the newer one, so listening on the phone
 * yesterday and on the desktop today is a streak of two.
 */
export function mergeStreakStates(a: StreakState, b: StreakState): StreakState {
  if (!a.lastDate) return b;
  if (!b.lastDate) return a;
  if (a.lastDate === b.lastDate) return { lastDate: a.lastDate, count: Math.max(a.count, b.count) };
  const [older, newer] = a.lastDate < b.lastDate ? [a, b] : [b, a];
  const consecutive = older.lastDate === yesterdayKey(dateFromKey(newer.lastDate));
  return {
    lastDate: newer.lastDate,
    count: consecutive ? Math.max(newer.count, older.count + 1) : newer.count,
  };
}

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yesterdayKey(d = new Date()): string {
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 1);
  return localDateKey(prev);
}

function readLocalStreakState(): StreakState {
  try {
    const raw =
      localStorage.getItem(STREAK_KEY) ??
      localStorage.getItem("rekord-resonance-streak") ??
      localStorage.getItem("kord-achievements-streak");
    return raw ? normalizeStreakState(JSON.parse(raw)) : { count: 0, lastDate: "" };
  } catch {
    return { count: 0, lastDate: "" };
  }
}

/** This device's copy merged with the hub's (when the session provides it). */
export function readStreakState(): StreakState {
  const local = readLocalStreakState();
  const synced = streakSync?.get();
  return synced == null ? local : mergeStreakStates(local, normalizeStreakState(synced));
}

export function writeStreakState(state: { count: number; lastDate: string }) {
  const next = normalizeStreakState(state);
  try {
    localStorage.setItem(STREAK_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the synced copy still has it */
  }
  if (streakSync) {
    const current = normalizeStreakState(streakSync.get());
    if (current.count !== next.count || current.lastDate !== next.lastDate) streakSync.set(next);
  }
  return next;
}

export function touchListeningActivity(at = new Date()): StreakState {
  const today = localDateKey(at);
  const prev = readStreakState();
  if (prev.lastDate === today) return prev;
  const next: StreakState = {
    lastDate: today,
    count: prev.lastDate === yesterdayKey(at) ? prev.count + 1 : 1,
  };
  return writeStreakState(next);
}

function effectiveStreakCount(stored: StreakState, at = new Date()): number {
  const today = localDateKey(at);
  if (stored.lastDate === today) return stored.count;
  if (stored.lastDate === yesterdayKey(at)) return stored.count;
  return 0;
}

export type TrackLike = {
  id: number;
  artist_name: string;
  album_id: number | null;
  album_name: string;
  rel_path: string;
  /** For callers passing `genreForTrack`: the genre comes from the track, not from the signals. */
  genre?: string | null;
};

export type AchievementsSnapshot = {
  signals: AchievementSignals;
  totalXp: number;
  level: { level: number; title: string; xpMin: number; xpMax: number };
  progress: { pct: number };
  achievements: {
    id: string;
    /** i18n key of the badge title. */
    titleKey: string;
    /** i18n key of the badge description. */
    descKey: string;
    xpBonus: number;
    icon: AchievementIconKind;
    unlocked: boolean;
    /** Where the account stands towards the badge. */
    progress: { value: number; target: number; pct: number };
    /** The library is too small for this badge to count yet. */
    requirement: (LibraryMinimum & { have: number }) | null;
  }[];
  streak: number;
};

export function buildAchievementsSnapshot(input: {
  playCounts: Record<string, number>;
  tracks: TrackLike[];
  favoritesCount: number;
  playlistsCount: number;
  playlistTrackCount: number;
  libraryTrackCount: number;
  libraryArtistCount?: number;
  libraryAlbumCount?: number;
  libraryGenreCount?: number;
  shuffleBlocks: number;
  genreForTrack: (t: TrackLike) => string | null;
  plectrTracksPlayed?: number;
  /**
   * Plectr career from `selectPlectrCareer(plectrRecords.store)`: its XP and
   * FC / AP counts feed the total; `tracksPlayed` wins over `plectrTracksPlayed`.
   */
  plectrCareer?: { tracksPlayed: number; fullCombos: number; allPerfects: number; xp: number } | null;
}): AchievementsSnapshot {
  const streak = effectiveStreakCount(readStreakState());
  const counts = input.playCounts;
  let totalPlays = 0;
  for (const n of Object.values(counts)) totalPlays += n;

  const artistPlayMap = new Map<string, number>();
  const genrePlayMap = new Map<string, number>();
  const albumsWithPlays = new Set<number | string>();
  let tracksWithPlays = 0;
  let topTrackPlays = 0;

  for (const tr of input.tracks) {
    const n = counts[tr.rel_path] ?? counts[String(tr.id)] ?? 0;
    if (n <= 0) continue;
    tracksWithPlays += 1;
    if (n > topTrackPlays) topTrackPlays = n;
    if (tr.album_id != null) albumsWithPlays.add(tr.album_id);
    else albumsWithPlays.add(`${tr.artist_name}/${tr.album_name}`);
    artistPlayMap.set(tr.artist_name, (artistPlayMap.get(tr.artist_name) ?? 0) + n);
    const g = input.genreForTrack(tr);
    // Same identity everywhere: "Hip Hop" / "hip-hop" are one genre (lib/genres).
    const key = g && g !== "Senza genere" ? normalizeGenreKey(g) : "";
    if (key) genrePlayMap.set(key, (genrePlayMap.get(key) ?? 0) + n);
  }

  let topArtistPlays = 0;
  for (const n of artistPlayMap.values()) {
    if (n > topArtistPlays) topArtistPlays = n;
  }

  const signals: AchievementSignals = {
    totalPlays,
    favoritesCount: input.favoritesCount,
    playlistsCount: input.playlistsCount,
    artistsWithPlays: artistPlayMap.size,
    genresWithPlays: genrePlayMap.size,
    tracksWithPlays,
    shuffleBlocks: input.shuffleBlocks,
    libraryTrackCount: input.libraryTrackCount,
    libraryArtistCount: input.libraryArtistCount,
    libraryAlbumCount: input.libraryAlbumCount,
    libraryGenreCount: input.libraryGenreCount,
    topArtistPlays,
    topTrackPlays,
    albumsWithPlays: albumsWithPlays.size,
    playlistTrackCount: input.playlistTrackCount,
    streak,
    plectrTracksPlayed: input.plectrCareer?.tracksPlayed ?? input.plectrTracksPlayed ?? 0,
    plectrFullCombos: input.plectrCareer?.fullCombos ?? 0,
    plectrAllPerfects: input.plectrCareer?.allPerfects ?? 0,
    plectrXp: Math.max(0, Math.round(input.plectrCareer?.xp ?? 0)),
  };

  const baseXp =
    signals.totalPlays +
    signals.favoritesCount * 5 +
    signals.playlistsCount * 10 +
    signals.artistsWithPlays * 3 +
    signals.shuffleBlocks * 2 +
    signals.plectrXp;

  let achievementXp = 0;
  const achievements = DEFINITIONS.map((def) => {
    let requirement: (LibraryMinimum & { have: number }) | null = null;
    if (def.minLibrary) {
      const have = libraryHas(signals, def.minLibrary.kind);
      if (have != null && have < def.minLibrary.need) requirement = { ...def.minLibrary, have };
    }
    const unlocked = requirement == null && def.check(signals);
    if (unlocked) achievementXp += def.xpBonus;
    const [value, target] = def.progress(signals);
    return {
      id: def.id,
      titleKey: achievementTitleKey(def.id),
      descKey: achievementDescKey(def.id),
      xpBonus: def.xpBonus,
      icon: def.icon,
      unlocked,
      progress: {
        value,
        target,
        pct: unlocked ? 100 : target > 0 ? Math.min(99, Math.floor((value / target) * 100)) : 0,
      },
      requirement,
    };
  });

  const totalXp = baseXp + achievementXp;
  const levelNum = numericLevelForXp(totalXp);
  const xpMin = xpMinForNumericLevel(levelNum);
  const xpMax = xpMaxForNumericLevel(levelNum);
  const span = Math.max(1, xpMax - xpMin + 1);
  const current = Math.min(span, Math.max(0, totalXp - xpMin));
  const pct = Math.min(100, Math.max(0, Math.round((current / span) * 100)));

  return {
    signals,
    totalXp,
    level: {
      level: levelNum,
      title: titleForNumericLevel(levelNum),
      xpMin,
      xpMax,
    },
    progress: { pct },
    achievements,
    streak,
  };
}
