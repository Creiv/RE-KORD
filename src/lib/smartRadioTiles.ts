import type { EnrichedTrack } from "../types";
import { fisherYatesShuffle } from "./smartShuffle";

export const SMART_RADIO_RECENT_COUNT = 2;
/** Massimo brani prelevati per visita (slot griglia − tasto Random). */
export const SMART_RADIO_MAX_DISPLAY_TRACKS = 19;

export function smartRadioAlbumKey(track: EnrichedTrack): string {
  if (track.albumId?.trim()) return track.albumId.trim();
  if (track.albumFolderRelPath?.trim()) {
    return track.albumFolderRelPath.trim().toLowerCase();
  }
  return `${track.artist.trim().toLowerCase()}\0${track.album.trim().toLowerCase()}`;
}

export function buildSmartRadioCandidatePool(
  recent: readonly EnrichedTrack[],
  favorites: readonly EnrichedTrack[],
): EnrichedTrack[] {
  const seen = new Set<string>();
  const pool: EnrichedTrack[] = [];
  const push = (track: EnrichedTrack) => {
    if (seen.has(track.relPath)) return;
    seen.add(track.relPath);
    pool.push(track);
  };
  for (const track of recent.slice(0, SMART_RADIO_RECENT_COUNT)) {
    push(track);
  }
  for (const track of favorites) {
    push(track);
  }
  return pool;
}

function pickUniqueAlbumTracks(
  source: readonly EnrichedTrack[],
  trackSlots: number,
  seenAlbums: Set<string>,
  seenPaths: Set<string>,
  picked: EnrichedTrack[],
): void {
  for (const track of fisherYatesShuffle(source)) {
    if (picked.length >= trackSlots) break;
    if (seenPaths.has(track.relPath)) continue;
    const albumKey = smartRadioAlbumKey(track);
    if (seenAlbums.has(albumKey)) continue;
    seenPaths.add(track.relPath);
    seenAlbums.add(albumKey);
    picked.push(track);
  }
}

function pickAnyTracks(
  source: readonly EnrichedTrack[],
  trackSlots: number,
  seenPaths: Set<string>,
  picked: EnrichedTrack[],
): void {
  for (const track of fisherYatesShuffle(source)) {
    if (picked.length >= trackSlots) break;
    if (seenPaths.has(track.relPath)) continue;
    seenPaths.add(track.relPath);
    picked.push(track);
  }
}

export function pickSmartRadioDisplayTracks(
  pool: readonly EnrichedTrack[],
  totalSlots: number,
  libraryFallback?: readonly EnrichedTrack[],
): EnrichedTrack[] {
  const trackSlots = Math.max(0, totalSlots - 1);
  if (trackSlots === 0) return [];
  const seenAlbums = new Set<string>();
  const seenPaths = new Set<string>();
  const picked: EnrichedTrack[] = [];

  pickUniqueAlbumTracks(pool, trackSlots, seenAlbums, seenPaths, picked);

  if (picked.length < trackSlots && libraryFallback?.length) {
    pickUniqueAlbumTracks(
      libraryFallback,
      trackSlots,
      seenAlbums,
      seenPaths,
      picked,
    );
  }

  // Librerie piccole: con meno album che slot il vincolo "un brano per album"
  // lascerebbe la griglia quasi vuota. Riempi gli slot residui senza vincolo.
  if (picked.length < trackSlots) {
    pickAnyTracks(pool, trackSlots, seenPaths, picked);
    if (picked.length < trackSlots && libraryFallback?.length) {
      pickAnyTracks(libraryFallback, trackSlots, seenPaths, picked);
    }
  }

  return picked;
}

export function pickRandomFromPool(
  pool: readonly EnrichedTrack[],
): EnrichedTrack | null {
  if (!pool.length) return null;
  const i = Math.floor(Math.random() * pool.length);
  return pool[i] ?? null;
}
