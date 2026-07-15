import { useCallback, useMemo } from "react";
import { useI18n } from "../../../i18n/useI18n";
import { buildLibraryTrackLookup, lookupLibraryTrack } from "../../../lib/libraryNav";
import type {
  LibraryAlbumIndex,
  LibraryArtistIndex,
  LibraryIndex,
  LibraryTrackIndex,
} from "../../../types";
import type { RouteState } from "../../../lib/routing";

interface UseLibraryArtistAlbumResolutionOptions {
  index: LibraryIndex;
  route: RouteState;
  artistAlbumSort: "date" | "name" | "plays";
  trackPlayCounts: Record<string, number>;
  playSequence: (
    tracks: LibraryTrackIndex[],
    startIndex: number
  ) => void;
}

export function useLibraryArtistAlbumResolution({
  index,
  route,
  artistAlbumSort,
  trackPlayCounts,
  playSequence,
}: UseLibraryArtistAlbumResolutionOptions) {
  const { sortLocale } = useI18n();

  const artist = route.artist
    ? index.artists.find((item) => item.id === route.artist) || null
    : null;

  const artistAlbums = useMemo(() => {
    if (!artist) return [];
    const counts = trackPlayCounts || {};
    const list = index.albums.filter((album) => album.artistId === artist.id);
    const next = [...list];
    if (artistAlbumSort === "date") {
      next.sort((a, b) => {
        const da = String(a.releaseDate || "");
        const db = String(b.releaseDate || "");
        if (!da && !db) {
          return a.name.localeCompare(b.name, sortLocale, { numeric: true });
        }
        if (!da) return 1;
        if (!db) return -1;
        return (
          db.localeCompare(da, undefined, { numeric: true }) ||
          a.name.localeCompare(b.name, sortLocale, { numeric: true })
        );
      });
    } else if (artistAlbumSort === "name") {
      next.sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    } else {
      const albumPlays = (al: LibraryAlbumIndex) => {
        let s = 0;
        for (const rel of al.tracks) {
          s += counts[rel] ?? 0;
        }
        return s;
      };
      next.sort(
        (a, b) =>
          albumPlays(b) - albumPlays(a) ||
          a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    }
    return next;
  }, [artist, index.albums, artistAlbumSort, sortLocale, trackPlayCounts]);

  const album = useMemo(() => {
    const albumRoute =
      route.album ||
      (artist &&
      artistAlbums.length === 1 &&
      artistAlbums[0]?.loose
        ? artistAlbums[0].name
        : null);
    if (!albumRoute || !artist) return null;
    return (
      artistAlbums.find(
        (item) => item.name === albumRoute || item.id === albumRoute,
      ) || null
    );
  }, [route.album, artist, artistAlbums]);

  const albumTracks = useMemo(() => {
    if (!album) return [];
    const lookup = buildLibraryTrackLookup(index.tracks);
    return album.tracks
      .map((relPath) => lookupLibraryTrack(lookup, { relPath }))
      .filter((track): track is LibraryTrackIndex => Boolean(track));
  }, [album, index.tracks]);

  const playAlbumTrackAt = useCallback(
    (trIndex: number) => playSequence(albumTracks, trIndex),
    [playSequence, albumTracks]
  );

  return {
    artist: artist as LibraryArtistIndex | null,
    artistAlbums,
    album,
    albumTracks,
    playAlbumTrackAt,
  };
}
