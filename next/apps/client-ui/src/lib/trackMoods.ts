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

/** Hash stabile per stub grafici (nessuna persistenza). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Preview deterministica per densità grafica fino a meta reali. */
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

/** Mood salvati utente, altrimenti preview grafica. */
export function resolveTrackMoods(
  trackId: number,
  relPath: string,
  saved?: Record<string, string[]>,
): TrackMoodId[] {
  const map = saved ?? {};
  const fromPrefs = normalizeMoodIds(map[String(trackId)] ?? map[relPath]);
  if (map[String(trackId)] != null || map[relPath] != null) return fromPrefs;
  return previewMoods(relPath);
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

/** @deprecated Use trackGenre / albumGenre — kept for call-site migration. */
export function previewGenre(_seed: string): string | null {
  return null;
}

/** @deprecated Use trackYear / releaseYear. */
export function previewYear(_seed: string): string | null {
  return null;
}

export function previewLabel(seed: string): string | null {
  void seed;
  return null;
}

export function lyricsKind(
  lyrics: string | null | undefined,
): "off" | "plain" | "lrc" {
  const t = lyrics?.trim() ?? "";
  if (!t) return "off";
  if (/\[\d{1,2}:\d{2}/.test(t)) return "lrc";
  return "plain";
}
