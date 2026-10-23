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

/** Title / description live in i18n: `achievements.badge.<id>.title|desc`. */
type AchievementDefinition = {
  id: string;
  xpBonus: number;
  icon: AchievementIconKind;
  check: (s: AchievementSignals) => boolean;
};

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
  { id: "first_play", xpBonus: 10, icon: "play", check: (s) => s.totalPlays >= 1 },
  { id: "plays_10", xpBonus: 15, icon: "play", check: (s) => s.totalPlays >= 10 },
  { id: "plays_25", xpBonus: 20, icon: "play", check: (s) => s.totalPlays >= 25 },
  { id: "plays_50", xpBonus: 30, icon: "play", check: (s) => s.totalPlays >= 50 },
  { id: "plays_100", xpBonus: 50, icon: "play", check: (s) => s.totalPlays >= 100 },
  { id: "plays_250", xpBonus: 75, icon: "play", check: (s) => s.totalPlays >= 250 },
  { id: "plays_500", xpBonus: 100, icon: "flame", check: (s) => s.totalPlays >= 500 },
  { id: "plays_1000", xpBonus: 150, icon: "flame", check: (s) => s.totalPlays >= 1000 },
  { id: "plays_2500", xpBonus: 200, icon: "flame", check: (s) => s.totalPlays >= 2500 },
  { id: "plays_5000", xpBonus: 300, icon: "flame", check: (s) => s.totalPlays >= 5000 },
  { id: "first_favorite", xpBonus: 15, icon: "heart", check: (s) => s.favoritesCount >= 1 },
  { id: "favorites_5", xpBonus: 25, icon: "heart", check: (s) => s.favoritesCount >= 5 },
  { id: "favorites_10", xpBonus: 40, icon: "heart", check: (s) => s.favoritesCount >= 10 },
  { id: "favorites_25", xpBonus: 60, icon: "heart", check: (s) => s.favoritesCount >= 25 },
  { id: "favorites_50", xpBonus: 90, icon: "heart", check: (s) => s.favoritesCount >= 50 },
  { id: "favorites_100", xpBonus: 120, icon: "heart", check: (s) => s.favoritesCount >= 100 },
  { id: "playlist_1", xpBonus: 30, icon: "list", check: (s) => s.playlistsCount >= 1 },
  { id: "playlists_3", xpBonus: 50, icon: "list", check: (s) => s.playlistsCount >= 3 },
  { id: "playlists_5", xpBonus: 70, icon: "list", check: (s) => s.playlistsCount >= 5 },
  { id: "playlists_10", xpBonus: 100, icon: "list", check: (s) => s.playlistsCount >= 10 },
  { id: "playlists_20", xpBonus: 140, icon: "list", check: (s) => s.playlistsCount >= 20 },
  { id: "artists_3", xpBonus: 20, icon: "artist", check: (s) => s.artistsWithPlays >= 3 },
  { id: "artists_5", xpBonus: 30, icon: "artist", check: (s) => s.artistsWithPlays >= 5 },
  { id: "artists_10", xpBonus: 45, icon: "artist", check: (s) => s.artistsWithPlays >= 10 },
  { id: "artists_20", xpBonus: 70, icon: "artist", check: (s) => s.artistsWithPlays >= 20 },
  { id: "artists_50", xpBonus: 110, icon: "artist", check: (s) => s.artistsWithPlays >= 50 },
  { id: "artists_100", xpBonus: 160, icon: "artist", check: (s) => s.artistsWithPlays >= 100 },
  { id: "genres_3", xpBonus: 25, icon: "genre", check: (s) => s.genresWithPlays >= 3 },
  { id: "genres_5", xpBonus: 40, icon: "genre", check: (s) => s.genresWithPlays >= 5 },
  { id: "genres_10", xpBonus: 60, icon: "genre", check: (s) => s.genresWithPlays >= 10 },
  { id: "genres_15", xpBonus: 80, icon: "genre", check: (s) => s.genresWithPlays >= 15 },
  { id: "genres_20", xpBonus: 100, icon: "genre", check: (s) => s.genresWithPlays >= 20 },
  { id: "tracks_10", xpBonus: 20, icon: "library", check: (s) => s.tracksWithPlays >= 10 },
  { id: "tracks_50", xpBonus: 50, icon: "library", check: (s) => s.tracksWithPlays >= 50 },
  { id: "tracks_100", xpBonus: 80, icon: "library", check: (s) => s.tracksWithPlays >= 100 },
  { id: "tracks_500", xpBonus: 150, icon: "library", check: (s) => s.tracksWithPlays >= 500 },
  { id: "shuffle_1", xpBonus: 15, icon: "shuffle", check: (s) => s.shuffleBlocks >= 1 },
  { id: "shuffle_3", xpBonus: 25, icon: "shuffle", check: (s) => s.shuffleBlocks >= 3 },
  { id: "shuffle_5", xpBonus: 40, icon: "shuffle", check: (s) => s.shuffleBlocks >= 5 },
  { id: "shuffle_10", xpBonus: 60, icon: "shuffle", check: (s) => s.shuffleBlocks >= 10 },
  { id: "shuffle_25", xpBonus: 90, icon: "shuffle", check: (s) => s.shuffleBlocks >= 25 },
  { id: "artist_plays_10", xpBonus: 35, icon: "artist", check: (s) => s.topArtistPlays >= 10 },
  { id: "artist_plays_25", xpBonus: 80, icon: "flame", check: (s) => s.topArtistPlays >= 25 },
  { id: "artist_plays_50", xpBonus: 120, icon: "flame", check: (s) => s.topArtistPlays >= 50 },
  { id: "artist_plays_100", xpBonus: 180, icon: "flame", check: (s) => s.topArtistPlays >= 100 },
  { id: "library_5pct", xpBonus: 40, icon: "library", check: (s) => libraryPctPlayed(s, 0.05) },
  { id: "library_10pct", xpBonus: 100, icon: "library", check: (s) => libraryPctPlayed(s, 0.1) },
  { id: "library_25pct", xpBonus: 160, icon: "library", check: (s) => libraryPctPlayed(s, 0.25) },
  { id: "library_50pct", xpBonus: 250, icon: "library", check: (s) => libraryPctPlayed(s, 0.5) },
  { id: "streak_3", xpBonus: 25, icon: "streak", check: (s) => s.streak >= 3 },
  { id: "streak_7", xpBonus: 50, icon: "streak", check: (s) => s.streak >= 7 },
  { id: "streak_14", xpBonus: 90, icon: "streak", check: (s) => s.streak >= 14 },
  { id: "streak_30", xpBonus: 150, icon: "streak", check: (s) => s.streak >= 30 },
  { id: "plays_7500", xpBonus: 400, icon: "flame", check: (s) => s.totalPlays >= 7500 },
  { id: "favorites_200", xpBonus: 200, icon: "heart", check: (s) => s.favoritesCount >= 200 },
  { id: "albums_10", xpBonus: 55, icon: "library", check: (s) => s.albumsWithPlays >= 10 },
  { id: "albums_50", xpBonus: 110, icon: "library", check: (s) => s.albumsWithPlays >= 50 },
  { id: "playlist_tracks_30", xpBonus: 85, icon: "list", check: (s) => s.playlistTrackCount >= 30 },
  { id: "track_plays_20", xpBonus: 70, icon: "play", check: (s) => s.topTrackPlays >= 20 },
  { id: "library_75pct", xpBonus: 320, icon: "library", check: (s) => libraryPctPlayed(s, 0.75) },
  { id: "plectr_tracks_10", xpBonus: 30, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 10 },
  { id: "plectr_tracks_50", xpBonus: 55, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 50 },
  { id: "plectr_tracks_100", xpBonus: 85, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 100 },
  { id: "plectr_tracks_250", xpBonus: 130, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 250 },
  { id: "plectr_tracks_500", xpBonus: 200, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 500 },
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
    const unlocked = def.check(signals);
    if (unlocked) achievementXp += def.xpBonus;
    return {
      id: def.id,
      titleKey: achievementTitleKey(def.id),
      descKey: achievementDescKey(def.id),
      xpBonus: def.xpBonus,
      icon: def.icon,
      unlocked,
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
