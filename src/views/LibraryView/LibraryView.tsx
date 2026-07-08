import type { RefObject } from "react";
import { useLibraryPlayback } from "../../hooks/useLibraryPlayback";
import type {
  LibraryEntityDelta,
  LibraryIndex,
} from "../../types";
import type { RouteState } from "../../lib/routing";
import { LibraryAlbumDetailView } from "./components/LibraryAlbumDetailView";
import { LibraryArtistDetailView } from "./components/LibraryArtistDetailView";
import { LibraryBrowseView } from "./components/LibraryBrowseView";
import { LibrarySearchView } from "./components/LibrarySearchView";
import { useLibraryAlbumDetail } from "./hooks/useLibraryAlbumDetail";
import { useLibraryArtistAlbumResolution } from "./hooks/useLibraryArtistAlbumResolution";
import { useLibraryBrowseData } from "./hooks/useLibraryBrowseData";
import { useLibraryBrowseState } from "./hooks/useLibraryBrowseState";
import { useLibrarySearch } from "./hooks/useLibrarySearch";

interface LibraryViewProps {
  index: LibraryIndex;
  route: RouteState;
  query: string;
  libraryHomeTick: number;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum: (artist: string, album: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showSearchBar: boolean;
  onSearchBarClose: () => void;
  onReconcileLibrary: (
    opts?: import("../../lib/libraryReconcile").LibraryReconcileOptions
  ) => Promise<void>;
  onLibraryDelta?: (delta: LibraryEntityDelta, reconcile?: boolean) => void;
}

export default function LibraryView({
  index,
  route,
  query,
  libraryHomeTick,
  onOpenArtist,
  onOpenAlbum,
  search,
  onSearchChange,
  searchInputRef,
  showSearchBar,
  onSearchBarClose,
  onReconcileLibrary,
  onLibraryDelta,
}: LibraryViewProps) {
  const {
    playSequence,
    playGlobalRadio,
    playCollectionShuffle,
    playPoolShuffle,
  } = useLibraryPlayback(index.tracks);

  const browseState = useLibraryBrowseState({
    libraryHomeTick,
    showSearchBar,
    onSearchBarClose,
  });

  const {
    libBrowse,
    libOverviewSort,
    artistAlbumSort,
    user,
    mode,
    setMode,
    selectedGenreKey,
    setSelectedGenreKey,
    moodFilterIds,
    setMoodFilterIds,
    moodMatchMode,
    setMoodMatchMode,
    endSearchForBrowse,
  } = browseState;

  const { normalizedQuery, searchResults, openSearchArtist, openSearchAlbum } =
    useLibrarySearch({
      index,
      query,
      route,
      search,
      onSearchChange,
      searchInputRef,
      showSearchBar,
      onOpenArtist,
      onOpenAlbum,
    });

  const { artist, artistAlbums, album, albumTracks, playAlbumTrackAt } =
    useLibraryArtistAlbumResolution({
      index,
      route,
      artistAlbumSort,
      trackPlayCounts: user.state.trackPlayCounts || {},
      playSequence,
    });

  const browseData = useLibraryBrowseData({
    index,
    libOverviewSort,
    trackPlayCounts: user.state.trackPlayCounts || {},
    shuffleExcludedAlbumIds: user.state.shuffleExcludedAlbumIds,
    shuffleExcludedTrackRelPaths: user.state.shuffleExcludedTrackRelPaths,
    selectedGenreKey,
    moodFilterIds,
    moodMatchMode,
    artist,
    artistAlbums,
  });

  const albumDetail = useLibraryAlbumDetail({
    album,
    albumTracks,
    index,
    onLibraryDelta,
    onReconcileLibrary,
  });

  const playLibraryShuffle = () => {
    playPoolShuffle(browseData.getLibraryShufflePool(), true);
  };

  const playArtistShuffle = () => {
    if (!artist) return;
    playPoolShuffle(browseData.getArtistShufflePool(), true);
  };

  if (normalizedQuery && searchResults) {
    return (
      <LibrarySearchView
        index={index}
        search={search}
        onSearchChange={onSearchChange}
        searchInputRef={searchInputRef}
        showSearchBar={showSearchBar}
        onSearchBarClose={onSearchBarClose}
        mode={mode}
        setMode={setMode}
        searchResults={searchResults}
        artistCoverById={browseData.artistCoverById}
        openSearchArtist={openSearchArtist}
        openSearchAlbum={openSearchAlbum}
        playGlobalRadio={playGlobalRadio}
      />
    );
  }

  if (album && artist) {
    return (
      <LibraryAlbumDetailView
        index={index}
        artist={artist}
        album={album}
        albumTracks={albumTracks}
        excludedAlbums={browseData.excludedAlbums}
        onOpenArtist={onOpenArtist}
        toggleShuffleExcludedAlbum={user.toggleShuffleExcludedAlbum}
        playSequence={playSequence}
        playAlbumTrackAt={playAlbumTrackAt}
        albumDetail={albumDetail}
      />
    );
  }

  if (artist && !album) {
    return (
      <LibraryArtistDetailView
        artist={artist}
        artistAlbums={artistAlbums}
        artistAlbumSort={artistAlbumSort}
        artistShuffleEligible={browseData.artistShuffleEligible}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        updateArtistAlbumSort={(sort) => user.updateSettings({ artistAlbumSort: sort })}
        playArtistShuffle={playArtistShuffle}
      />
    );
  }

  return (
    <LibraryBrowseView
      index={index}
      libBrowse={libBrowse}
      libOverviewSort={libOverviewSort}
      search={search}
      onSearchChange={onSearchChange}
      searchInputRef={searchInputRef}
      showSearchBar={showSearchBar}
      onSearchBarClose={onSearchBarClose}
      selectedGenreKey={selectedGenreKey}
      setSelectedGenreKey={setSelectedGenreKey}
      moodFilterIds={moodFilterIds}
      setMoodFilterIds={setMoodFilterIds}
      moodMatchMode={moodMatchMode}
      setMoodMatchMode={setMoodMatchMode}
      endSearchForBrowse={endSearchForBrowse}
      updateLibBrowse={(browse) => user.updateSettings({ libBrowse: browse })}
      updateLibOverviewSort={(sort) => user.updateSettings({ libOverviewSort: sort })}
      setShuffleTracksExcludedBulk={user.setShuffleTracksExcludedBulk}
      onOpenArtist={onOpenArtist}
      playPoolShuffle={playPoolShuffle}
      playCollectionShuffle={playCollectionShuffle}
      playLibraryShuffle={playLibraryShuffle}
      browseData={browseData}
    />
  );
}
