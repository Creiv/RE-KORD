import { parseTrackGenres } from "./genres";

export const TRACK_MOOD_IDS = [
  "energy_boost",
  "party_dance",
  "chill_relax",
  "focus_study",
  "romantic_intimacy",
  "sad_melancholy",
  "dark_tense",
  "aggressive_heavy",
  "dreamy_ethereal",
  "epic_cinematic",
  "nostalgia_retro",
  "fun_quirky",
  "soulful_groovy",
  "motivational_drive",
] as const;

export type TrackMoodId = (typeof TRACK_MOOD_IDS)[number];

export const MAX_TRACK_MOODS = 3;

export const TRACK_MOOD_COLORS: Record<TrackMoodId, string> = {
  energy_boost: "#f59e0b",
  party_dance: "#ec4899",
  chill_relax: "#22c55e",
  focus_study: "#6366f1",
  romantic_intimacy: "#fb7185",
  sad_melancholy: "#38bdf8",
  dark_tense: "#7c3aed",
  aggressive_heavy: "#dc2626",
  dreamy_ethereal: "#06b6d4",
  epic_cinematic: "#eab308",
  nostalgia_retro: "#b45309",
  fun_quirky: "#84cc16",
  soulful_groovy: "#ea580c",
  motivational_drive: "#d1d5db",
};

/** i18n key of a mood's label (same keys as legacy: `trackMeta.mood.<id>`). */
export function trackMoodLabelKey(id: TrackMoodId): string {
  return `trackMeta.mood.${id}`;
}

/**
 * Italian fallback labels. UI should translate with `t(trackMoodLabelKey(id))`;
 * kept for callers that have no i18n at hand.
 */
export const TRACK_MOOD_LABELS: Record<TrackMoodId, string> = {
  energy_boost: "Energia / boost",
  party_dance: "Party / dance",
  chill_relax: "Chill / relax",
  focus_study: "Focus / studio",
  romantic_intimacy: "Romantic / intimità",
  sad_melancholy: "Triste / malinconico",
  dark_tense: "Dark / tensione",
  aggressive_heavy: "Aggressivo / heavy",
  dreamy_ethereal: "Onirico / etereo",
  epic_cinematic: "Epico / cinematografico",
  nostalgia_retro: "Nostalgia / retro",
  fun_quirky: "Divertente / ironico",
  soulful_groovy: "Soulful / groovy",
  motivational_drive: "Motivazionale",
};

/**
 * Data key of the "no genre" bucket in genre groupings. A sentinel, never shown:
 * the UI translates it (`library.noGenre`), and it cannot clash with a real
 * genre named like the translated label.
 */
export const NO_GENRE_KEY = "\u0000no-genre";

export const GENRE_POOL = [
  "Hip-Hop",
  "Rap",
  "Rock",
  "Alternative",
  "Electronic",
  "Pop",
  "Metal",
  "Indie",
  "R&B",
  "Jazz",
] as const;

/** Stable hash for graphic stubs (no persistence). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic preview for graphic density until real meta exists. */
export function previewMoods(seed: string): TrackMoodId[] {
  const h = hashSeed(seed);
  if (h % 5 === 0) return [];
  const a = TRACK_MOOD_IDS[h % TRACK_MOOD_IDS.length];
  const b = TRACK_MOOD_IDS[(h >> 4) % TRACK_MOOD_IDS.length];
  return a === b ? [a] : [a, b].slice(0, 1 + (h % 2));
}

export function normalizeMoodIds(raw: unknown): TrackMoodId[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackMoodId[] = [];
  for (const x of raw) {
    let id = String(x);
    if (id === "uplifting_happy") id = "motivational_drive";
    if ((TRACK_MOOD_IDS as readonly string[]).includes(id) && !out.includes(id as TrackMoodId)) {
      out.push(id as TrackMoodId);
    }
    if (out.length >= MAX_TRACK_MOODS) break;
  }
  return out;
}

/**
 * Saved personal moods (rel_path preferred; numeric id only for the legacy client).
 * No “preview” fallback: without a save → empty list (previews remain
 * only for decorative tiles via `previewMoods`).
 */
export function resolveTrackMoods(
  trackId: number,
  relPath: string,
  saved?: Record<string, string[]>,
): TrackMoodId[] {
  const map = saved ?? {};
  if (Object.prototype.hasOwnProperty.call(map, relPath)) {
    return normalizeMoodIds(map[relPath]);
  }
  const idKey = String(trackId);
  if (Object.prototype.hasOwnProperty.call(map, idKey)) {
    return normalizeMoodIds(map[idKey]);
  }
  return [];
}

export function trackMatchesMoodFilter(
  moods: TrackMoodId[],
  filterIds: string[],
  matchAll: boolean,
): boolean {
  if (!filterIds.length) return true;
  if (matchAll) return filterIds.every((id) => moods.includes(id as TrackMoodId));
  const need = new Set(filterIds);
  return moods.some((m) => need.has(m));
}

/** Real genre from track/album API fields (no hash preview). */
export function trackGenre(
  track: { genre?: string | null } | null | undefined,
  album?: { genre?: string | null } | null,
): string | null {
  const g = track?.genre?.trim() || album?.genre?.trim() || "";
  return g || null;
}

export function albumGenre(album: { genre?: string | null } | null | undefined): string | null {
  const g = album?.genre?.trim() || "";
  return g || null;
}

/**
 * Legacy `trackHasFileMeta`: a track is "ok" when it has a genre or a release
 * date. Used for note badges and the "tracks without meta" alert, with the
 * hub's rule (`db::quality`): junk and placeholder genre tokens ("8",
 * "Unknown", "Music") are not a genre. Reads the `genre` field, not the hub's
 * `genres` list, so a local edit counts at once.
 */
export function trackHasFileMeta(
  track: { genre?: string | null; release_date?: string | null } | null | undefined,
): boolean {
  if (!track) return false;
  if (track.release_date?.trim()) return true;
  return Boolean(track.genre?.trim()) && parseTrackGenres(track.genre).length > 0;
}

/**
 * Legacy `hasAlbumMeta`: album sidecar/studio meta applied, or any album-level
 * date / label / country (the hub counts it the same way, `db::quality`).
 */
export function albumHasAlbumMeta(album: {
  has_album_meta?: boolean;
  release_date?: string | null;
  label?: string | null;
  country?: string | null;
} | null | undefined): boolean {
  if (!album) return false;
  if (album.has_album_meta) return true;
  return Boolean(
    album.release_date?.trim() || album.label?.trim() || album.country?.trim(),
  );
}

/** Year from release_date (`YYYY…` or full date). */
export function releaseYear(
  releaseDate: string | null | undefined,
): string | null {
  if (!releaseDate) return null;
  const m = String(releaseDate).trim().match(/^(\d{4})/);
  return m ? m[1] : null;
}

export function trackYear(
  track: { release_date?: string | null } | null | undefined,
  album?: { release_date?: string | null } | null,
): string | null {
  return releaseYear(track?.release_date) || releaseYear(album?.release_date);
}

/** Value for `<input type="date">` — accepts ISO date or year-only (`2024` → `2024-01-01`). */
export function toDateInputValue(raw: string | null | undefined): string {
  if (!raw?.trim()) return "";
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

/** Display format dd-mm-yyyy (legacy `fmtDate`). */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const v = String(d).trim();
  if (!v) return "—";
  const p = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (p) return `${p[3]}-${p[2]}-${p[1]}`;
  if (/^\d{4}$/.test(v)) return v;
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getDate())}-${pad(dt.getMonth() + 1)}-${dt.getFullYear()}`;
}

export function lyricsKind(
  lyrics: string | null | undefined,
): "off" | "plain" | "lrc" {
  const t = lyrics?.trim() ?? "";
  if (!t) return "off";
  if (/\[\d{1,2}:\d{2}/.test(t)) return "lrc";
  return "plain";
}
