import type { EnrichedTrack, LibraryIndex, LibraryTrackIndex } from "../types";

export function isTrackShuffleExcluded(
  track: { relPath: string; albumId?: string; artist: string; album: string },
  excludedTracks: Set<string>,
  excludedAlbums: Set<string>
): boolean {
  return (
    excludedTracks.has(track.relPath) ||
    isTrackAlbumShuffleExcluded(track, excludedAlbums)
  );
}

export function filterTracksForShuffleExclusions<T extends EnrichedTrack>(
  tracks: readonly T[],
  excludedTracks: Set<string>,
  excludedAlbums: Set<string>
): T[] {
  return tracks.filter(
    (track) => !isTrackShuffleExcluded(track, excludedTracks, excludedAlbums)
  );
}

export function isTrackAlbumShuffleExcluded(
  t: { albumId?: string; artist: string; album: string },
  exAlbum: Set<string>
): boolean {
  if (t.albumId) return exAlbum.has(t.albumId);
  return exAlbum.has(`${t.artist}/${t.album}`);
}

export function eligibleTracksForIntelligentRandom(
  index: LibraryIndex,
  excludedAlbums: Set<string>,
  excludedTracks: Set<string>
): LibraryTrackIndex[] {
  return index.tracks.filter(
    (track) =>
      !excludedTracks.has(track.relPath) &&
      !isTrackAlbumShuffleExcluded(track, excludedAlbums)
  );
}
