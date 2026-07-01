import { useCallback, useMemo } from "react";
import { resolveTrackFromLibrary } from "../lib/libraryNav";
import type { EnrichedTrack } from "../types";
import { usePlayer } from "../context/PlayerContext";
import { useUserState } from "../context/UserStateContext";
import {
  buildCardPlayQueueFromSeed,
  buildShuffleQueueFromSeed,
  buildSmartRandomQueue,
  splitQueueWindow,
} from "../lib/smartShuffle";
import {
  filterTracksForShuffleExclusions,
  isTrackShuffleExcluded,
} from "../lib/randomExclusions";

export function useLibraryPlayback(
  libraryTracks: readonly EnrichedTrack[] | undefined
) {
  const p = usePlayer();
  const user = useUserState();
  const excludedAlbums = useMemo(
    () => new Set(user.state.shuffleExcludedAlbumIds),
    [user.state.shuffleExcludedAlbumIds]
  );
  const excludedTracks = useMemo(
    () => new Set(user.state.shuffleExcludedTrackRelPaths),
    [user.state.shuffleExcludedTrackRelPaths]
  );

  const shuffleOpts = useCallback(
    () => ({
      currentRelPath: p.current?.relPath,
      currentArtist: p.current?.artist,
      recentRelPaths: new Set(
        user.state.recent.slice(0, 48).map((tr) => tr.relPath)
      ),
      excludedAlbums,
      excludedTracks,
    }),
    [p.current?.relPath, p.current?.artist, user.state.recent, excludedAlbums, excludedTracks]
  );

  const playSequence = useCallback(
    (tracks: readonly EnrichedTrack[], startIndex: number) => {
      if (!tracks.length) return;
      const idx = Math.max(0, Math.min(startIndex, tracks.length - 1));
      p.playTrack(tracks[idx]!, [...tracks], idx, { preserveQueueOrder: true });
    },
    [p]
  );

  /** Coda generata → finestra subito in player, resto travasato a lotti. */
  const playWindowed = useCallback(
    (full: readonly EnrichedTrack[]) => {
      if (!full.length) return;
      const { window, remainder } = splitQueueWindow(full);
      p.playTrack(window[0]!, window, 0, {
        preserveQueueOrder: true,
        refillRemainder: remainder,
      });
    },
    [p]
  );

  const radioRespectsExclusions = useCallback(
    (seed: EnrichedTrack, respectExclusions: boolean) => {
      if (!respectExclusions) return false;
      return !isTrackShuffleExcluded(seed, excludedTracks, excludedAlbums);
    },
    [excludedAlbums, excludedTracks]
  );

  const playGlobalRadio = useCallback(
    (seed: EnrichedTrack, respectExclusions = true) => {
      const resolvedSeed =
        libraryTracks?.length
          ? resolveTrackFromLibrary(seed, libraryTracks)
          : seed;
      if (!libraryTracks?.length) {
        p.playTrack(resolvedSeed, [resolvedSeed], 0);
        return;
      }
      const q = buildCardPlayQueueFromSeed(resolvedSeed, libraryTracks, {
        respectExclusions: radioRespectsExclusions(
          resolvedSeed,
          respectExclusions
        ),
        excludedAlbums,
        excludedTracks,
      });
      playWindowed(q);
    },
    [
      libraryTracks,
      p,
      excludedAlbums,
      excludedTracks,
      playWindowed,
      radioRespectsExclusions,
    ]
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
        respectExclusions: radioRespectsExclusions(
          resolved,
          respectExclusions
        ),
        excludedAlbums,
        excludedTracks,
      });
      const prefix = p.queue.slice(0, curIdx + 1);
      const prefixPaths = new Set(prefix.map((t) => t.relPath));
      const newTail = generated.slice(1).filter((t) => !prefixPaths.has(t.relPath));
      const newFull = [...prefix, ...newTail];
      const { window, remainder } = splitQueueWindow(newFull);
      p.replaceQueueKeepingPlayback(window, { refillRemainder: remainder });
    },
    [libraryTracks, p, excludedAlbums, excludedTracks, radioRespectsExclusions],
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