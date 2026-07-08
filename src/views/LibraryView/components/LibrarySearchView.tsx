import type { RefObject } from "react";
import { TrackListRow } from "../../../components/AppSharedUi";
import { AlbumListTile, ArtistListTile } from "../../../components/library";
import {
  UiAlbumIcon,
  UiMusicNote,
  UiPerson,
  UiViewModule,
} from "../../../components/RekordUiIcons";
import { useI18n } from "../../../i18n/useI18n";
import type { LibraryIndex, LibraryTrackIndex } from "../../../types";
import type { LibrarySearchFilterMode } from "../hooks/useLibraryBrowseState";
import { LibrarySearchHero } from "./LibrarySearchHero";

interface LibrarySearchViewProps {
  index: LibraryIndex;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showSearchBar: boolean;
  onSearchBarClose: () => void;
  mode: LibrarySearchFilterMode;
  setMode: (mode: LibrarySearchFilterMode) => void;
  searchResults: {
    artists: LibraryIndex["artists"];
    albums: LibraryIndex["albums"];
    tracks: LibraryTrackIndex[];
  };
  artistCoverById: Map<string, string | null>;
  openSearchArtist: (artistId: string) => void;
  openSearchAlbum: (artistId: string, albumName: string) => void;
  playGlobalRadio: (track: LibraryTrackIndex, shuffle?: boolean) => void;
}

export function LibrarySearchView({
  index,
  search,
  onSearchChange,
  searchInputRef,
  showSearchBar,
  onSearchBarClose,
  mode,
  setMode,
  searchResults,
  artistCoverById,
  openSearchArtist,
  openSearchAlbum,
  playGlobalRadio,
}: LibrarySearchViewProps) {
  const { t } = useI18n();

  return (
    <div className="view-page library-page library-view library-view--search-results">
      {showSearchBar ? (
        <LibrarySearchHero
          search={search}
          onSearchChange={onSearchChange}
          searchInputRef={searchInputRef}
          onSearchBarClose={onSearchBarClose}
        />
      ) : null}
      <section className="surface-card library-search-results-card">
        <div className="library-filter-panel">
          <span className="library-filter-panel__eyebrow">
            {t("library.filterBarSearch")}
          </span>
          <div className="library-search-filter-row">
            <div
              className="segmented segmented--filter"
              role="group"
              aria-label={t("library.filterResultsAria")}
            >
              {(
                [
                  {
                    id: "all" as const,
                    labelKey: "library.filterAll",
                    Ic: UiViewModule,
                  },
                  {
                    id: "artists" as const,
                    labelKey: "library.filterArtists",
                    Ic: UiPerson,
                  },
                  {
                    id: "albums" as const,
                    labelKey: "library.filterAlbums",
                    Ic: UiAlbumIcon,
                  },
                  {
                    id: "tracks" as const,
                    labelKey: "library.filterTracks",
                    Ic: UiMusicNote,
                  },
                ] as const
              ).map(({ id, labelKey, Ic }) => (
                <button
                  type="button"
                  key={id}
                  className={mode === id ? "is-on" : ""}
                  onClick={() => setMode(id)}
                >
                  <span className="segmented__btn-inner">
                    <Ic className="segmented__ic" aria-hidden />
                    <span>{t(labelKey)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        {(mode === "all" || mode === "artists") && (
          <div className="subsection">
            <h3>{t("library.subArtists")}</h3>
            <div className="library-overview-cols">
              {searchResults.artists.slice(0, 12).map((item) => (
                <ArtistListTile
                  key={item.id}
                  artist={item}
                  albumCount={item.albums.length}
                  coverAlbumRelPath={artistCoverById.get(item.id) ?? null}
                  index={index}
                  onOpen={() => openSearchArtist(item.id)}
                />
              ))}
            </div>
          </div>
        )}
        {(mode === "all" || mode === "albums") && (
          <div className="subsection">
            <h3>{t("library.subAlbums")}</h3>
            <div className="library-overview-cols">
              {searchResults.albums.slice(0, 12).map((item) => (
                <AlbumListTile
                  key={item.id}
                  album={item}
                  showArtistLine
                  onOpen={() => openSearchAlbum(item.artistId, item.name)}
                />
              ))}
            </div>
          </div>
        )}
        {(mode === "all" || mode === "tracks") && (
          <div className="subsection">
            <h3>{t("library.subTracks")}</h3>
            <div className="list-stack">
              {searchResults.tracks.slice(0, 50).map((track) => (
                <TrackListRow
                  key={track.relPath}
                  track={track}
                  onPlay={() => playGlobalRadio(track, true)}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
