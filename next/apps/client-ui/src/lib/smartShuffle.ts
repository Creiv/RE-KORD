import type { Track } from "./api";
import { resolveTrackMoods, trackGenre, type TrackMoodId } from "./trackMoods";
import { loadUserPrefs } from "./userPrefs";

export const CARD_QUEUE_CAP = 500;

export function fisherYatesShuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function spreadConsecutiveArtists(tracks: Track[]): void {
  const n = tracks.length;
  if (n < 2) return;
  let guard = 0;
  const maxGuard = n * n;
  while (guard < maxGuard) {
    guard += 1;
    let swapped = false;
    for (let i = 0; i < n - 1; i += 1) {
      if (tracks[i].artist_name !== tracks[i + 1].artist_name) continue;
      let j = i + 2;
      while (j < n && tracks[j].artist_name === tracks[i].artist_name) j += 1;
      if (j >= n) continue;
      [tracks[i + 1], tracks[j]] = [tracks[j], tracks[i + 1]];
      swapped = true;
    }
    if (!swapped) break;
  }
}

function moodsFor(track: Track): TrackMoodId[] {
  return resolveTrackMoods(track.id, track.rel_path, loadUserPrefs().trackMoods);
}

function genresFor(track: Track): string[] {
  const g = trackGenre(track);
  return g ? [g.toLowerCase()] : [];
}

export function seedSimilarityScore(seed: Track, candidate: Track): number {
  const seedMoods = moodsFor(seed);
  let moodScore = 0;
  if (seedMoods.length > 0) {
    const set = new Set(seedMoods);
    const overlap = moodsFor(candidate).filter((m) => set.has(m)).length;
    moodScore = overlap / seedMoods.length;
  }
  const seedGenres = genresFor(seed);
  let genreScore = 0;
  if (seedGenres.length > 0) {
    const set = new Set(seedGenres);
    const overlap = genresFor(candidate).filter((g) => set.has(g)).length;
    genreScore = overlap / seedGenres.length;
  }
  const artistBonus =
    seed.artist_name.trim().toLowerCase() === candidate.artist_name.trim().toLowerCase()
      ? 0.05
      : 0;
  return moodScore + genreScore + artistBonus;
}

export function buildSmartRandomQueue(
  tracks: readonly Track[],
  opts: {
    currentRelPath?: string;
    currentArtist?: string;
    recentRelPaths?: ReadonlySet<string>;
  } = {},
): Track[] {
  if (!tracks.length) return [];
  let a = fisherYatesShuffle(tracks);
  const recent = opts.recentRelPaths;
  if (recent && recent.size > 0) {
    const fresh = a.filter((t) => !recent.has(t.rel_path));
    const stale = a.filter((t) => recent.has(t.rel_path));
    if (fresh.length > 0) a = [...fresh, ...stale];
  }
  spreadConsecutiveArtists(a);
  if (opts.currentRelPath && a[0]?.rel_path === opts.currentRelPath) {
    const k = a.findIndex((t) => t.rel_path !== opts.currentRelPath);
    if (k > 0) [a[0], a[k]] = [a[k], a[0]];
  }
  if (opts.currentArtist && a.length > 1 && a[0].artist_name === opts.currentArtist) {
    const k = a.findIndex((t) => t.artist_name !== opts.currentArtist);
    if (k > 0) {
      [a[0], a[k]] = [a[k], a[0]];
      spreadConsecutiveArtists(a);
    }
  }
  return a;
}

export function buildRadioFromSeed(
  seed: Track,
  library: readonly Track[],
  opts?: { maxLength?: number; recentRelPaths?: ReadonlySet<string> },
): Track[] {
  const cap = Math.max(1, Math.min(opts?.maxLength ?? CARD_QUEUE_CAP, CARD_QUEUE_CAP));
  const pool = library.filter((t) => t.rel_path !== seed.rel_path);
  const scored = pool.map((track) => ({
    track,
    score: seedSimilarityScore(seed, track),
    jitter: Math.random(),
  }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.jitter - b.jitter));
  let ordered = scored.map((s) => s.track);
  const recent = opts?.recentRelPaths;
  if (recent && recent.size > 0) {
    const fresh = ordered.filter((t) => !recent.has(t.rel_path));
    const stale = ordered.filter((t) => recent.has(t.rel_path));
    if (fresh.length) ordered = [...fresh, ...stale];
  }
  const full = [seed, ...ordered];
  spreadConsecutiveArtists(full);
  return full.slice(0, cap);
}
