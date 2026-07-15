/**
 * Journal delta libreria per sync incrementale client.
 * Popolato da persistIncrementalToDb / persistLibraryIndexToDb.
 */
import path from "path";
import { getLibraryEpoch } from "./db/index.mjs";

/** @typedef {{ epoch: number, removedTrackPaths: string[], addedTrackPaths: string[], updatedAlbums: object[], updatedTracks?: object[], fullRefreshRecommended?: boolean }} DeltaJournalEntry */

/** @type {Map<string, DeltaJournalEntry[]>} */
const deltaJournal = new Map();

const MAX_JOURNAL_ENTRIES = 32;

function rootKey(root) {
  return path.resolve(String(root || ""));
}

export function resetLibraryDeltaJournalForTests(root) {
  resetLibraryDeltaJournalForRoot(root);
}

/** Reset journal delta per un root (es. cambio musicRoot). */
export function resetLibraryDeltaJournalForRoot(root) {
  if (root) deltaJournal.delete(rootKey(root));
  else deltaJournal.clear();
}

/**
 * @param {string} root
 * @param {DeltaJournalEntry} entry
 */
export function recordLibraryDelta(root, entry) {
  const key = rootKey(root);
  const list = deltaJournal.get(key) || [];
  list.push(entry);
  while (list.length > MAX_JOURNAL_ENTRIES) list.shift();
  deltaJournal.set(key, list);
}

/**
 * @param {string} root
 * @param {number} epoch
 * @param {{ removedPaths?: string[], index?: { albums?: object[], tracks?: object[] }, full?: boolean }} scanResult
 */
export function recordLibraryDeltaFromScan(root, epoch, scanResult = {}) {
  if (scanResult.full) {
    recordLibraryDelta(root, {
      epoch,
      removedTrackPaths: [],
      addedTrackPaths: [],
      updatedAlbums: [],
      updatedTracks: [],
      fullRefreshRecommended: true,
    });
    return;
  }
  const removedTrackPaths = [...(scanResult.removedPaths || [])];
  const addedTrackPaths = (scanResult.index?.tracks || []).map((t) => t.relPath);
  const updatedAlbums = (scanResult.index?.albums || []).map((album) => ({
    relPath: album.relPath,
    name: album.name,
    artist: album.artist,
    artistId: album.artistId,
    trackCount: album.trackCount,
    coverRelPath: album.coverRelPath ?? null,
    hasCover: album.hasCover,
    hasAlbumMeta: album.hasAlbumMeta,
    updatedAt: album.updatedAt ?? null,
    tracks: album.tracks || [],
  }));
  const updatedTracks = scanResult.index?.tracks || [];
  recordLibraryDelta(root, {
    epoch,
    removedTrackPaths,
    addedTrackPaths,
    updatedAlbums,
    updatedTracks,
    fullRefreshRecommended: false,
  });
}

/**
 * @param {string} root
 * @param {number} sinceEpoch
 */
export function buildLibraryDelta(root, sinceEpoch) {
  const indexEpoch = getLibraryEpoch(root);
  const empty = {
    changed: false,
    indexEpoch,
    removedTrackPaths: [],
    addedTrackPaths: [],
    updatedAlbums: [],
    updatedTracks: [],
    fullRefreshRecommended: false,
  };
  if (sinceEpoch >= indexEpoch) return empty;

  const entries = (deltaJournal.get(rootKey(root)) || []).filter(
    (e) => e.epoch > sinceEpoch,
  );
  if (!entries.length) {
    return {
      changed: true,
      indexEpoch,
      removedTrackPaths: [],
      addedTrackPaths: [],
      updatedAlbums: [],
      updatedTracks: [],
      fullRefreshRecommended: true,
    };
  }
  if (entries.some((e) => e.fullRefreshRecommended)) {
    return {
      changed: true,
      indexEpoch,
      removedTrackPaths: [],
      addedTrackPaths: [],
      updatedAlbums: [],
      updatedTracks: [],
      fullRefreshRecommended: true,
    };
  }

  const removedSet = new Set();
  const addedSet = new Set();
  /** @type {Map<string, object>} */
  const albumMap = new Map();
  /** @type {Map<string, object>} */
  const trackMap = new Map();
  for (const entry of entries) {
    for (const p of entry.removedTrackPaths) removedSet.add(p);
    for (const p of entry.addedTrackPaths) addedSet.add(p);
    for (const album of entry.updatedAlbums) {
      if (album?.relPath) albumMap.set(album.relPath, album);
    }
    for (const track of entry.updatedTracks || []) {
      if (track?.relPath) trackMap.set(track.relPath, track);
    }
  }
  for (const p of removedSet) {
    addedSet.delete(p);
    trackMap.delete(p);
  }

  const changeCount =
    removedSet.size + addedSet.size + albumMap.size;
  const fullRefreshRecommended = changeCount > 500;

  return {
    changed: true,
    indexEpoch,
    removedTrackPaths: [...removedSet],
    addedTrackPaths: [...addedSet],
    updatedAlbums: [...albumMap.values()],
    updatedTracks: [...trackMap.values()],
    fullRefreshRecommended,
  };
}
