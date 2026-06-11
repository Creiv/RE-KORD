import { useCallback, useMemo } from "react";
import type { EnrichedTrack } from "../types";
import { usePlayer } from "../context/PlayerContext";
import { useUserState } from "../context/UserStateContext";
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

  const playGlobalRadio = useCallback(
    (seed: EnrichedTrack, respectExclusions = true) => {
      if (!libraryTracks?.length) {
        p.playTrack(seed, [seed], 0);
        return;
      }
      const q = buildCardPlayQueueFromSeed(seed, libraryTracks, {
        respectExclusions,
        excludedAlbums,
        excludedTracks,
      });
      playWindowed(q);
    },
    [libraryTracks, p, excludedAlbums, excludedTracks, playWindowed]
  );

  const playCollectionShuffle = useCallback(
    (
      seed: EnrichedTrack,
      pool: readonly EnrichedTrack[],
      respectExclusions = true
    ) => {
      if (!pool.length) return;
      const q = buildShuffleQueueFromSeed(seed, pool, {
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

  return {
    playSequence,
    playGlobalRadio,
    playCollectionShuffle,
    playPoolShuffle,
    excludedAlbums,
    excludedTracks,
  };
}