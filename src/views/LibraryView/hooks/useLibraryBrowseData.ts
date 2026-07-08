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
}: UseLibraryBrowseDataOptions) {
  const { t, sortLocale } = useI18n();

  const excludedAlbums = useMemo(
    () => new Set(shuffleExcludedAlbumIds),
    [shuffleExcludedAlbumIds]
  );
  const excludedTracks = useMemo(
    () => new Set(shuffleExcludedTrackRelPaths),
    [shuffleExcludedTrackRelPaths]
  );

  const artistShuffleEligible = useMemo(() => {
    if (!artist) return [] as LibraryTrackIndex[];
    const rels = new Set(artistAlbums.flatMap((al) => al.tracks));
    return index.tracks.filter(
      (tr) =>
        rels.has(tr.relPath) &&
        !excludedTracks.has(tr.relPath) &&
        !isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [artist, artistAlbums, index.tracks, excludedAlbums, excludedTracks]);

  const artistCoverById = useMemo(
    () => buildRandomArtistCoverMap(index),
    [index]
  );
  const genreCoverByKey = useMemo(
    () => buildGenreCoverPreviewMap(index),
    [index]
  );

  const genreAlbumTrackCounts = useMemo(() => {
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
  }, [index.tracks]);

  const genreIndex = useMemo(() => {
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
  }, [index.tracks, sortLocale]);

  const tracksInSelectedGenre = useMemo(() => {
    if (!selectedGenreKey) return [] as LibraryTrackIndex[];
    return index.tracks.filter((tr) =>
      trackBelongsToGenreKey(tr.meta?.genre, selectedGenreKey)
    );
  }, [index.tracks, selectedGenreKey]);

  const selectedGenreLabel = useMemo(() => {
    if (!selectedGenreKey) return null;
    if (selectedGenreKey === "__none__") return t("library.noGenreLabel");
    return (
      genreIndex.list.find((g) => g.key === selectedGenreKey)?.label ??
      selectedGenreKey
    );
  }, [selectedGenreKey, genreIndex.list, t]);

  const sortedGenreTracks = useMemo(() => {
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
  }, [tracksInSelectedGenre, sortLocale, libOverviewSort, trackPlayCounts]);

  const genreToolbarBulkAllExcluded = useMemo(() => {
    if (!tracksInSelectedGenre.length) return false;
    return tracksInSelectedGenre.every(
      (tr) =>
        excludedTracks.has(tr.relPath) ||
        isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [tracksInSelectedGenre, excludedTracks, excludedAlbums]);

  const selectedGenreAlbumCount =
    selectedGenreKey != null
      ? genreAlbumTrackCounts.get(selectedGenreKey)?.albums.size ?? 0
      : 0;

  const sortedOverviewArtists = useMemo(() => {
    const counts = trackPlayCounts || {};
    const list = [...index.artists];
    if (libOverviewSort === "name") {
      list.sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    } else {
      const sumPlays = (ar: LibraryArtistIndex) => {
        let s = 0;
        for (const tr of index.tracks) {
          if (tr.artist === ar.name) s += counts[tr.relPath] ?? 0;
        }
        return s;
      };
      list.sort(
        (a, b) =>
          sumPlays(b) - sumPlays(a) ||
          a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
    }
    return list;
  }, [index.artists, index.tracks, libOverviewSort, sortLocale, trackPlayCounts]);

  const sortedGenreBrowseList = useMemo(() => {
    const counts = trackPlayCounts || {};
    const list = [...genreIndex.list];
    if (libOverviewSort === "name") {
      list.sort((a, b) =>
        a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    } else {
      const playsForGenreKey = (key: string) => {
        let s = 0;
        for (const tr of index.tracks) {
          if (!trackBelongsToGenreKey(tr.meta?.genre, key)) continue;
          s += counts[tr.relPath] ?? 0;
        }
        return s;
      };
      list.sort(
        (a, b) =>
          playsForGenreKey(b.key) - playsForGenreKey(a.key) ||
          a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    }
    return list;
  }, [genreIndex.list, index.tracks, libOverviewSort, sortLocale, trackPlayCounts]);

  const moodOccurrenceCountById = useMemo(() => {
    const m = new Map<TrackMoodId, number>();
    for (const id of TRACK_MOOD_IDS) m.set(id, 0);
    for (const tr of index.tracks) {
      for (const mid of parseTrackMoods(tr.meta ?? undefined)) {
        m.set(mid, (m.get(mid) ?? 0) + 1);
      }
    }
    return m;
  }, [index.tracks]);

  const tracksMatchingMoodFilter = useMemo(() => {
    if (moodFilterIds.length === 0) return [] as LibraryTrackIndex[];
    const need = new Set(moodFilterIds);
    return index.tracks.filter((tr) => {
      const moods = parseTrackMoods(tr.meta ?? undefined);
      if (moodMatchMode === "any") {
        return moods.some((mid) => need.has(mid));
      }
      return moodFilterIds.every((mid) => moods.includes(mid));
    });
  }, [index.tracks, moodFilterIds, moodMatchMode]);

  const sortedMoodTracks = useMemo(() => {
    const base = [...tracksMatchingMoodFilter];
    base.sort(
      (a, b) =>
        a.artist.localeCompare(b.artist, sortLocale, { numeric: true }) ||
        a.album.localeCompare(b.album, sortLocale, { numeric: true }) ||
        a.title.localeCompare(b.title, sortLocale, { numeric: true })
    );
    return base;
  }, [tracksMatchingMoodFilter, sortLocale]);

  const moodToolbarBulkAllExcluded = useMemo(() => {
    if (!tracksMatchingMoodFilter.length) return false;
    return tracksMatchingMoodFilter.every(
      (tr) =>
        excludedTracks.has(tr.relPath) ||
        isTrackAlbumShuffleExcluded(tr, excludedAlbums)
    );
  }, [tracksMatchingMoodFilter, excludedTracks, excludedAlbums]);

  const getLibraryShufflePool = () =>
    eligibleTracksForIntelligentRandom(
      index,
      excludedAlbums,
      excludedTracks
    );

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
