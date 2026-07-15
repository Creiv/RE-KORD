import { useCallback, useMemo } from "react";
import { resolveTrackFromLibrary } from "../lib/libraryNav";
import type { EnrichedTrack } from "../types";
import { usePlayer } from "../context/PlayerContext";
import {
  useUserShuffleSlice,
  useUserStateSelector,
} from "../context/UserStateContext";
import {
  buildCardPlayQueueFromSeed,
  buildShuffleQueueFromSeed,
  buildSmartRandomQueue,
  splitQueueWindow,
} from "../lib/smartShuffle";
import { filterTracksForShuffleExclusions } from "../lib/randomExclusions";

export function useLibraryPlayback(
  libraryTracks: readonly EnrichedTrack[] | undefined
) {
  const p = usePlayer();
  const { shuffleExcludedAlbumIds, shuffleExcludedTrackRelPaths } =
    useUserShuffleSlice();
  const recent = useUserStateSelector((s) => s.state.recent);
  const excludedAlbums = useMemo(
    () => new Set(shuffleExcludedAlbumIds),
    [shuffleExcludedAlbumIds]
  );
  const excludedTracks = useMemo(
    () => new Set(shuffleExcludedTrackRelPaths),
    [shuffleExcludedTrackRelPaths]
  );

  const currentRelPath = p.current?.relPath;
  const currentArtist = p.current?.artist;
  // Dipendenza granulare: p cambia a ogni tick del player, playTrack no.
  const playTrack = p.playTrack;
  const shuffleOpts = useCallback(
    () => ({
      currentRelPath,
      currentArtist,
      recentRelPaths: new Set(
        recent.slice(0, 48).map((tr) => tr.relPath)
      ),
      excludedAlbums,
      excludedTracks,
    }),
    [currentRelPath, currentArtist, recent, excludedAlbums, excludedTracks]
  );

  const playSequence = useCallback(
    (tracks: readonly EnrichedTrack[], startIndex: number) => {
      if (!tracks.length) return;
      const idx = Math.max(0, Math.min(startIndex, tracks.length - 1));
      playTrack(tracks[idx]!, [...tracks], idx, { preserveQueueOrder: true });
    },
    [playTrack]
  );

  /** Coda generata → finestra subito in player, resto travasato a lotti. */
  const playWindowed = useCallback(
    (full: readonly EnrichedTrack[]) => {
      if (!full.length) return;
      const { window, remainder } = splitQueueWindow(full);
      playTrack(window[0]!, window, 0, {
        preserveQueueOrder: true,
        refillRemainder: remainder,
      });
    },
    [playTrack]
  );

  const playGlobalRadio = useCallback(
    (seed: EnrichedTrack, respectExclusions = true) => {
      const resolvedSeed =
        libraryTracks?.length
          ? resolveTrackFromLibrary(seed, libraryTracks)
          : seed;
      if (!libraryTracks?.length) {
        playTrack(resolvedSeed, [resolvedSeed], 0);
        return;
      }
      const q = buildCardPlayQueueFromSeed(resolvedSeed, libraryTracks, {
        ...shuffleOpts(),
        respectExclusions,
      });
      playWindowed(q);
    },
    [libraryTracks, playTrack, playWindowed, shuffleOpts]
  );

  const playCollectionShuffle = useCallback(
    (
      seed: EnrichedTrack,
      pool: readonly EnrichedTrack[],
      respectExclusions = true
    ) => {
      if (!pool.length) return;
      const resolvedSeed = resolveTrackFromLibrary(seed, pool);
      const q = buildShuffleQueueFromSeed(resolvedSeed, pool, {
        ...shuffleOpts(),
        respectExclusions,
      });
      playWindowed(q);
    },
    [playWindowed, shuffleOpts]
  );

  const playPoolShuffle = useCallback(
    (pool: readonly EnrichedTrack[], respectExclusions = true) => {
      if (!pool.length) return;
      let eligible = [...pool];
      if (respectExclusions) {
        eligible = filterTracksForShuffleExclusions(
          eligible,
          excludedTracks,
          excludedAlbums
        );
      }
      if (!eligible.length) return;
      const shuffled = buildSmartRandomQueue(eligible, shuffleOpts());
      playWindowed(shuffled);
    },
    [playWindowed, shuffleOpts, excludedTracks, excludedAlbums]
  );

  const playRadioFromCurrent = useCallback(
    (respectExclusions = true) => {
      const current = p.current;
      if (!current || !libraryTracks?.length) return;
      const curIdx = p.currentIndex;
      const resolved = resolveTrackFromLibrary(current, libraryTracks);
      const generated = buildCardPlayQueueFromSeed(resolved, libraryTracks, {
        ...shuffleOpts(),
        respectExclusions,
      });
      const prefix = p.queue.slice(0, curIdx + 1);
      const prefixPaths = new Set(prefix.map((t) => t.relPath));
      const newTail = generated.slice(1).filter((t) => !prefixPaths.has(t.relPath));
      const newFull = [...prefix, ...newTail];
      const { window, remainder } = splitQueueWindow(newFull);
      p.replaceQueueKeepingPlayback(window, { refillRemainder: remainder });
    },
    [libraryTracks, p, shuffleOpts],
  );

  return {
    playSequence,
    playGlobalRadio,
    playRadioFromCurrent,
    playCollectionShuffle,
    playPoolShuffle,
    excludedAlbums,
    excludedTracks,
  };
}