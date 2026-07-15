import { useMemo } from "react";
import { useI18n } from "../../../i18n/useI18n";
import { buildRandomArtistCoverMap } from "../../../lib/artistCover";
import { buildGenreCoverPreviewMap } from "../../../lib/genreCovers";
import {
  parseTrackGenres,
  trackBelongsToGenreKey,
} from "../../../lib/genres";
import {
  eligibleTracksForIntelligentRandom,
  isTrackAlbumShuffleExcluded,
} from "../../../lib/randomExclusions";
import {
  parseTrackMoods,
  TRACK_MOOD_IDS,
  type TrackMoodId,
} from "../../../lib/trackMoods";
import type {
  LibraryAlbumIndex,
  LibraryArtistIndex,
  LibraryIndex,
  LibraryTrackIndex,
} from "../../../types";

export type LibraryBrowseDataScope = "browse" | "search" | "artist" | "album";

interface UseLibraryBrowseDataOptions {
  index: LibraryIndex;
  libOverviewSort: "name" | "plays";
  trackPlayCounts: Record<string, number>;
  shuffleExcludedAlbumIds: string[];
  shuffleExcludedTrackRelPaths: string[];
  selectedGenreKey: string | null;
  moodFilterIds: TrackMoodId[];
  moodMatchMode: "any" | "all";
  artist: LibraryArtistIndex | null;
  artistAlbums: LibraryAlbumIndex[];
  /** Limita calcoli O(n) al sotto-view attivo. Default: browse. */
  scope?: LibraryBrowseDataScope;
}

export function useLibraryBrowseData({
  index,
  libOverviewSort,
  trackPlayCounts,
  shuffleExcludedAlbumIds,
  shuffleExcludedTrackRelPaths,
  selectedGenreKey,
  moodFilterIds,
  moodMatchMode,
  artist,
  artistAlbums,
  scope = "browse",
}: UseLibraryBrowseDataOptions) {
  const { t, sortLocale } = useI18n();
  const isBrowse = scope === "browse";
  const needsCovers = isBrowse || scope === "search";
  const needsArtistShuffle = isBrowse || scope === "artist";

  const excludedAlbums = useMemo(
    () => new Set(shuffleExcludedAlbumIds),
    [shuffleExcludedAlbumIds]
  );
  const excludedTracks = useMemo(
    () => new Set(shuffleExcludedTrackRelPaths),
    [shuffleExcludedTrackRelPaths]
  );

  const playsByArtistName = useMemo(() => {
    if (!isBrowse) return new Map<string, number>();
    const counts = trackPlayCounts || {};
    const m = new Map<string, number>();
    for (const tr of index.tracks) {
      m.set(tr.artist, (m.get(tr.artist) ?? 0) + (counts[tr.relPath] ?? 0));
    }
    return m;
  }, [index.tracks, trackPlayCounts, isBrowse]);

  const playsByGenreKey = useMemo(() => {
    if (!isBrowse) return new Map<string, number>();
    const counts = trackPlayCounts || {};
    const m = new Map<string, number>();
    for (const tr of index.tracks) {
      const play = counts[tr.relPath] ?? 0;
      if (!play) continue;
      const toks = parseTrackGenres(tr.meta?.genre);
      if (toks.length === 0) {
        m.set("__none__", (m.get("__none__") ?? 0) + play);
        continue;
      }
      for (const raw of toks) {
        const key = raw.toLowerCase();
        m.set(key, (m.get(key) ?? 0) + play);
      }
    }
    return m;
  }, [index.tracks, trackPlayCounts, isBrowse]);

  const artistShuffleEligible = useMemo(() => {
    if (!needsArtistShuffle || !artist) return [] as LibraryTrackIndex[];
    const rels = new Set(artistAlbums.flatMap((al) => al.tracks));
    return index.tracks.filter(
      (tr) =>
        rels.has(tr.relPath) &&
        !excludedTracks.has(tr.relPath) &&
        !isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [artist, artistAlbums, index.tracks, excludedAlbums, excludedTracks, needsArtistShuffle]);

  const artistCoverById = useMemo(
    () => (needsCovers ? buildRandomArtistCoverMap(index) : new Map()),
    [index, needsCovers],
  );
  const genreCoverByKey = useMemo(
    () => (isBrowse ? buildGenreCoverPreviewMap(index) : new Map()),
    [index, isBrowse],
  );

  const genreAlbumTrackCounts = useMemo(() => {
    if (!isBrowse) return new Map<string, { albums: Set<string>; tracks: number }>();
    const m = new Map<string, { albums: Set<string>; tracks: number }>();
    const bump = (key: string, albumId: string) => {
      let e = m.get(key);
      if (!e) {
        e = { albums: new Set<string>(), tracks: 0 };
        m.set(key, e);
      }
      e.tracks += 1;
      if (albumId) e.albums.add(albumId);
    };
    for (const tr of index.tracks) {
      const toks = parseTrackGenres(tr.meta?.genre);
      if (toks.length === 0) bump("__none__", tr.albumId);
      else for (const g of toks) bump(g.toLowerCase(), tr.albumId);
    }
    return m;
  }, [index.tracks, isBrowse]);

  const genreIndex = useMemo(() => {
    if (!isBrowse) return { list: [] as { key: string; label: string; count: number }[], noGenreCount: 0 };
    const byLower = new Map<string, { label: string; count: number }>();
    let noGenre = 0;
    for (const tr of index.tracks) {
      const toks = parseTrackGenres(tr.meta?.genre);
      if (toks.length === 0) {
        noGenre += 1;
        continue;
      }
      for (const raw of toks) {
        const low = raw.toLowerCase();
        const prev = byLower.get(low);
        if (!prev) byLower.set(low, { label: raw, count: 1 });
        else prev.count += 1;
      }
    }
    const list = Array.from(byLower.entries())
      .map(([key, v]) => ({ key, label: v.label, count: v.count }))
      .sort((a, b) =>
        a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    return { list, noGenreCount: noGenre };
  }, [index.tracks, sortLocale, isBrowse]);

  const tracksInSelectedGenre = useMemo(() => {
    if (!isBrowse || !selectedGenreKey) return [] as LibraryTrackIndex[];
    return index.tracks.filter((tr) =>
      trackBelongsToGenreKey(tr.meta?.genre, selectedGenreKey)
    );
  }, [index.tracks, selectedGenreKey, isBrowse]);

  const selectedGenreLabel = useMemo(() => {
    if (!isBrowse || !selectedGenreKey) return null;
    if (selectedGenreKey === "__none__") return t("library.noGenreLabel");
    return (
      genreIndex.list.find((g) => g.key === selectedGenreKey)?.label ??
      selectedGenreKey
    );
  }, [selectedGenreKey, genreIndex.list, t, isBrowse]);

  const sortedGenreTracks = useMemo(() => {
    if (!isBrowse) return [] as LibraryTrackIndex[];
    const base = [...tracksInSelectedGenre];
    const counts = trackPlayCounts || {};
    if (libOverviewSort === "plays") {
      base.sort(
        (a, b) =>
          (counts[b.relPath] ?? 0) - (counts[a.relPath] ?? 0) ||
          a.artist.localeCompare(b.artist, sortLocale, { numeric: true }) ||
          a.album.localeCompare(b.album, sortLocale, { numeric: true }) ||
          a.title.localeCompare(b.title, sortLocale, { numeric: true })
      );
    } else {
      base.sort(
        (a, b) =>
          a.artist.localeCompare(b.artist, sortLocale, { numeric: true }) ||
          a.album.localeCompare(b.album, sortLocale, { numeric: true }) ||
          a.title.localeCompare(b.title, sortLocale, { numeric: true })
      );
    }
    return base;
  }, [tracksInSelectedGenre, sortLocale, libOverviewSort, trackPlayCounts, isBrowse]);

  const genreToolbarBulkAllExcluded = useMemo(() => {
    if (!isBrowse || !tracksInSelectedGenre.length) return false;
    return tracksInSelectedGenre.every(
      (tr) =>
        excludedTracks.has(tr.relPath) ||
        isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [tracksInSelectedGenre, excludedTracks, excludedAlbums, isBrowse]);

  const selectedGenreAlbumCount =
    isBrowse && selectedGenreKey != null
      ? genreAlbumTrackCounts.get(selectedGenreKey)?.albums.size ?? 0
      : 0;

  const sortedOverviewArtists = useMemo(() => {
    if (!isBrowse) return [] as LibraryIndex["artists"];
    const list = [...index.artists];
    if (libOverviewSort === "name") {
      list.sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    } else {
      list.sort(
        (a, b) =>
          (playsByArtistName.get(b.name) ?? 0) -
            (playsByArtistName.get(a.name) ?? 0) ||
          a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    }
    return list;
  }, [index.artists, libOverviewSort, sortLocale, playsByArtistName, isBrowse]);

  const sortedGenreBrowseList = useMemo(() => {
    if (!isBrowse) return [] as { key: string; label: string; count: number }[];
    const list = [...genreIndex.list];
    if (libOverviewSort === "name") {
      list.sort((a, b) =>
        a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    } else {
      list.sort(
        (a, b) =>
          (playsByGenreKey.get(b.key) ?? 0) - (playsByGenreKey.get(a.key) ?? 0) ||
          a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    }
    return list;
  }, [genreIndex.list, libOverviewSort, sortLocale, playsByGenreKey, isBrowse]);

  const moodOccurrenceCountById = useMemo(() => {
    if (!isBrowse) return new Map<TrackMoodId, number>();
    const m = new Map<TrackMoodId, number>();
    for (const id of TRACK_MOOD_IDS) m.set(id, 0);
    for (const tr of index.tracks) {
      for (const mid of parseTrackMoods(tr.meta ?? undefined)) {
        m.set(mid, (m.get(mid) ?? 0) + 1);
      }
    }
    return m;
  }, [index.tracks, isBrowse]);

  const tracksMatchingMoodFilter = useMemo(() => {
    if (!isBrowse || moodFilterIds.length === 0) return [] as LibraryTrackIndex[];
    const need = new Set(moodFilterIds);
    return index.tracks.filter((tr) => {
      const moods = parseTrackMoods(tr.meta ?? undefined);
      if (moodMatchMode === "any") {
        return moods.some((mid) => need.has(mid));
      }
      return moodFilterIds.every((mid) => moods.includes(mid));
    });
  }, [index.tracks, moodFilterIds, moodMatchMode, isBrowse]);

  const sortedMoodTracks = useMemo(() => {
    if (!isBrowse) return [] as LibraryTrackIndex[];
    const base = [...tracksMatchingMoodFilter];
    base.sort(
      (a, b) =>
        a.artist.localeCompare(b.artist, sortLocale, { numeric: true }) ||
        a.album.localeCompare(b.album, sortLocale, { numeric: true }) ||
        a.title.localeCompare(b.title, sortLocale, { numeric: true })
    );
    return base;
  }, [tracksMatchingMoodFilter, sortLocale, isBrowse]);

  const moodToolbarBulkAllExcluded = useMemo(() => {
    if (!isBrowse || !tracksMatchingMoodFilter.length) return false;
    return tracksMatchingMoodFilter.every(
      (tr) =>
        excludedTracks.has(tr.relPath) ||
        isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [tracksMatchingMoodFilter, excludedTracks, excludedAlbums, isBrowse]);

  const getLibraryShufflePool = () => {
    if (!isBrowse) return [] as LibraryTrackIndex[];
    return eligibleTracksForIntelligentRandom(
      index,
      excludedAlbums,
      excludedTracks,
    );
  };

  const getArtistShufflePool = () => {
    if (!artist) return [] as LibraryTrackIndex[];
    const rels = new Set(artistAlbums.flatMap((al) => al.tracks));
    return index.tracks.filter((tr) => rels.has(tr.relPath));
  };

  return {
    excludedAlbums,
    excludedTracks,
    artistShuffleEligible,
    artistCoverById,
    genreCoverByKey,
    genreAlbumTrackCounts,
    genreIndex,
    tracksInSelectedGenre,
    selectedGenreLabel,
    sortedGenreTracks,
    genreToolbarBulkAllExcluded,
    selectedGenreAlbumCount,
    sortedOverviewArtists,
    sortedGenreBrowseList,
    moodOccurrenceCountById,
    tracksMatchingMoodFilter,
    sortedMoodTracks,
    moodToolbarBulkAllExcluded,
    getLibraryShufflePool,
    getArtistShufflePool,
  };
}
