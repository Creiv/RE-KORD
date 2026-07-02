import type { EnrichedTrack } from "../types";
import { resolveTrackFromLibrary } from "./libraryNav";
import { parseTrackGenres } from "./genres";
import { isTrackShuffleExcluded } from "./randomExclusions";
import { parseTrackMoods } from "./trackMoods";

const CARD_QUEUE_CAP = 500;

/**
 * Finestra scorrevole della coda: in PlayerContext vivono solo i primi
 * QUEUE_WINDOW_LENGTH brani; il resto della coda generata resta come
 * "remainder" in memoria e viene travasato a lotti man mano che l'ascolto
 * avanza. Così persistenza (PUT stato utente) e stato React restano piccoli
 * senza ridurre la durata d'ascolto.
 */
export const QUEUE_WINDOW_LENGTH = 50;
/** Brani travasati dal remainder a ogni rabbocco. */
export const QUEUE_REFILL_BATCH = 30;
/** Rabbocca quando davanti al corrente restano così pochi brani. */
export const QUEUE_REFILL_THRESHOLD = 10;
/** Brani già riprodotti tenuti dietro al corrente (per "precedente"/storia). */
export const QUEUE_HISTORY_KEEP = 20;

export function splitQueueWindow(full: readonly EnrichedTrack[]): {
  window: EnrichedTrack[];
  remainder: EnrichedTrack[];
} {
  return {
    window: full.slice(0, QUEUE_WINDOW_LENGTH),
    remainder: full.slice(QUEUE_WINDOW_LENGTH),
  };
}

export function fisherYatesShuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function spreadConsecutiveArtists(tracks: EnrichedTrack[]): void {
  const n = tracks.length;
  if (n < 2) return;
  let guard = 0;
  const maxGuard = n * n;
  while (guard < maxGuard) {
    guard += 1;
    let swapped = false;
    for (let i = 0; i < n - 1; i += 1) {
      if (tracks[i].artist !== tracks[i + 1].artist) continue;
      let j = i + 2;
      while (j < n && tracks[j].artist === tracks[i].artist) j += 1;
      if (j >= n) continue;
      [tracks[i + 1], tracks[j]] = [tracks[j], tracks[i + 1]];
      swapped = true;
    }
    if (!swapped) break;
  }
}

export type SmartShuffleOpts = {
  currentRelPath?: string;
  currentArtist?: string;
  recentRelPaths?: ReadonlySet<string>;
};

export type ShuffleExclusionOpts = {
  respectExclusions?: boolean;
  excludedAlbums?: Set<string>;
  excludedTracks?: Set<string>;
};

function filterPoolForExclusions(
  pool: readonly EnrichedTrack[],
  seedRelPath: string | null,
  opts?: ShuffleExclusionOpts
): EnrichedTrack[] {
  if (!opts?.respectExclusions) return [...pool];
  const exA = opts.excludedAlbums ?? new Set<string>();
  const exT = opts.excludedTracks ?? new Set<string>();
  return pool.filter(
    (t) =>
      (seedRelPath != null && t.relPath === seedRelPath) ||
      !isTrackShuffleExcluded(t, exT, exA)
  );
}

/** Generi traccia con fallback su albumMeta (come Nebula). */
function trackGenresForScoring(track: EnrichedTrack): string[] {
  return parseTrackGenres(track.meta?.genre ?? track.albumMeta?.genre).map(
    (g) => g.toLowerCase(),
  );
}

function artistMatches(seed: EnrichedTrack, t: EnrichedTrack): boolean {
  return (
    seed.artist.trim().toLowerCase() === t.artist.trim().toLowerCase()
  );
}

/** Punteggio similarità seed → candidato (lessicografico: mood → generi → artista). */
export function seedSimilarityScore(
  seed: EnrichedTrack,
  candidate: EnrichedTrack,
): number {
  const seedMoods = parseTrackMoods(seed.meta);
  let moodTier = 0;
  if (seedMoods.length > 0) {
    const moodSet = new Set(seedMoods);
    const overlap = parseTrackMoods(candidate.meta).filter((m) =>
      moodSet.has(m),
    ).length;
    moodTier = overlap / seedMoods.length;
  }

  const seedGenres = trackGenresForScoring(seed);
  let genreTier = 0;
  if (seedGenres.length > 0) {
    const seedGenreSet = new Set(seedGenres);
    const candidateGenres = trackGenresForScoring(candidate);
    const overlap = candidateGenres.filter((g) => seedGenreSet.has(g)).length;
    genreTier = overlap / seedGenres.length;
  }

  const artistTier = artistMatches(seed, candidate) ? 1 : 0;

  // Codifica lessicografica: mood domina sempre genere, genere domina artista.
  return moodTier * 1_000_000 + genreTier * 1_000 + artistTier;
}

function sortPoolBySeedSimilarity(
  seed: EnrichedTrack,
  pool: readonly EnrichedTrack[],
): EnrichedTrack[] {
  const scored = pool.map((track) => ({
    track,
    score: seedSimilarityScore(seed, track),
    jitter: Math.random(),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.jitter - b.jitter;
  });

  // Spread artista consecutivi solo dentro la stessa fascia di score,
  // così non si inverte l'ordine mood → genere → artista.
  const byScore = new Map<number, EnrichedTrack[]>();
  for (const { track, score } of scored) {
    const band = byScore.get(score);
    if (band) band.push(track);
    else byScore.set(score, [track]);
  }
  const ordered: EnrichedTrack[] = [];
  for (const score of [...byScore.keys()].sort((a, b) => b - a)) {
    const band = byScore.get(score)!;
    spreadConsecutiveArtists(band);
    ordered.push(...band);
  }
  return ordered;
}

export function buildShuffleQueueFromSeed(
  seed: EnrichedTrack,
  pool: readonly EnrichedTrack[],
  opts: SmartShuffleOpts & ShuffleExclusionOpts = {}
): EnrichedTrack[] {
  const seedCanon = resolveTrackFromLibrary(seed, pool);
  const filtered = filterPoolForExclusions(pool, seedCanon.relPath, opts);
  const rest = filtered.filter((t) => t.relPath !== seedCanon.relPath);
  if (!rest.length) return [seedCanon];
  const shuffled = buildSmartRandomQueue(rest, opts);
  return [seedCanon, ...shuffled];
}

export function buildCardPlayQueueFromSeed(
  seed: EnrichedTrack,
  libraryTracks: readonly EnrichedTrack[],
  opts?: { maxLength?: number } & ShuffleExclusionOpts
): EnrichedTrack[] {
  const maxLen =
    opts?.maxLength !== undefined ? opts.maxLength : CARD_QUEUE_CAP;
  const cap = Math.max(1, Math.min(maxLen, CARD_QUEUE_CAP));
  const seedCanon = resolveTrackFromLibrary(seed, libraryTracks);
  const pool = filterPoolForExclusions(
    libraryTracks,
    seedCanon.relPath,
    opts
  ).filter((t) => t.relPath !== seedCanon.relPath);

  const tail = sortPoolBySeedSimilarity(seedCanon, pool);
  const full = [seedCanon, ...tail];
  return full.slice(0, cap);
}

export function buildSmartRandomQueue(
  tracks: readonly EnrichedTrack[],
  opts: SmartShuffleOpts = {}
): EnrichedTrack[] {
  if (!tracks.length) return [];
  let a = fisherYatesShuffle(tracks);

  const recent = opts.recentRelPaths;
  if (recent && recent.size > 0) {
    const fresh = a.filter((t) => !recent.has(t.relPath));
    const stale = a.filter((t) => recent.has(t.relPath));
    if (fresh.length > 0) a = [...fresh, ...stale];
  }

  spreadConsecutiveArtists(a);

  const avoidPath = opts.currentRelPath;
  if (avoidPath && a[0]?.relPath === avoidPath) {
    const k = a.findIndex((t) => t.relPath !== avoidPath);
    if (k > 0) [a[0], a[k]] = [a[k], a[0]];
  }

  const avoidArtist = opts.currentArtist;
  if (avoidArtist && a.length > 1 && a[0].artist === avoidArtist) {
    const k = a.findIndex((t) => t.artist !== avoidArtist);
    if (k > 0) {
      [a[0], a[k]] = [a[k], a[0]];
      spreadConsecutiveArtists(a);
    }
  }

  return a;
}
