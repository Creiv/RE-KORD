import { lazy, Suspense } from "react";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import { TrackListRow } from "../../../components/AppSharedUi";
import { PlayCollectionButton } from "../../../components/PlayCollectionButton";
import { ArtistListTile, GenreListTile } from "../../../components/library";
import { ExcludeShuffleIcon } from "../../../components/ExcludeShuffleIcon";
import { TrackMoodGlyph } from "../../../components/TrackMoodGlyph";
import { VirtualTrackList } from "../../../components/VirtualTrackList";
import { VirtualOverviewGrid } from "../../../components/VirtualOverviewGrid";
import {
  UiAutoAwesome,
  UiBarChart,
  UiChevronLeft,
  UiPalette,
  UiPerson,
  UiSortByAlpha,
  UiStyle,
} from "../../../components/RekordUiIcons";
import { useI18n } from "../../../i18n/useI18n";
import {
  TRACK_MOOD_COLORS,
  TRACK_MOOD_IDS,
  type TrackMoodId,
} from "../../../lib/trackMoods";
import type { LibraryIndex, LibraryTrackIndex } from "../../../types";
import type { useLibraryBrowseData } from "../hooks/useLibraryBrowseData";
import { usePaginatedArtists } from "../hooks/usePaginatedArtists";
import { LibrarySearchHero } from "./LibrarySearchHero";

const SonicNebulaView = lazy(
  () => import("../../SonicNebulaView/SonicNebulaView"),
);

interface LibraryBrowseViewProps {
  index: LibraryIndex;
  libBrowse: "artists" | "genres" | "moods" | "nebula";
  libOverviewSort: "name" | "plays";
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showSearchBar: boolean;
  onSearchBarClose: () => void;
  selectedGenreKey: string | null;
  setSelectedGenreKey: (key: string | null) => void;
  moodFilterIds: TrackMoodId[];
  setMoodFilterIds: Dispatch<SetStateAction<TrackMoodId[]>>;
  moodMatchMode: "any" | "all";
  setMoodMatchMode: (mode: "any" | "all") => void;
  endSearchForBrowse: () => void;
  updateLibBrowse: (browse: "artists" | "genres" | "moods" | "nebula") => void;
  updateLibOverviewSort: (sort: "name" | "plays") => void;
  setShuffleTracksExcludedBulk: (relPaths: string[], excluded: boolean) => void;
  onOpenArtist: (artist: string) => void;
  playPoolShuffle: (pool: LibraryTrackIndex[], intelligent?: boolean) => void;
  playCollectionShuffle: (
    track: LibraryTrackIndex,
    pool: LibraryTrackIndex[],
    intelligent?: boolean
  ) => void;
  playLibraryShuffle: () => void;
  browseData: ReturnType<typeof useLibraryBrowseData>;
}

export function LibraryBrowseView({
  index,
  libBrowse,
  libOverviewSort,
  search,
  onSearchChange,
  searchInputRef,
  showSearchBar,
  onSearchBarClose,
  selectedGenreKey,
  setSelectedGenreKey,
  moodFilterIds,
  setMoodFilterIds,
  moodMatchMode,
  setMoodMatchMode,
  endSearchForBrowse,
  updateLibBrowse,
  updateLibOverviewSort,
  setShuffleTracksExcludedBulk,
  onOpenArtist,
  playPoolShuffle,
  playCollectionShuffle,
  playLibraryShuffle,
  browseData,
}: LibraryBrowseViewProps) {
  const { t } = useI18n();

  const {
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
  } = browseData;

  const paginatedArtists = usePaginatedArtists({
    sort: libOverviewSort === "plays" ? "tracks" : "name",
    enabled: libBrowse === "artists",
  });
  const artistsForOverview = paginatedArtists.enabled
    ? (paginatedArtists.artists.length ? paginatedArtists.artists : sortedOverviewArtists)
    : sortedOverviewArtists;

  return (
    <div
      className={`view-page library-page${
        libBrowse === "nebula" && !selectedGenreKey ? " library-page--nebula" : ""
      }`}
    >
      <div className="library-page__chrome">
        {showSearchBar ? (
          <LibrarySearchHero
            search={search}
            onSearchChange={onSearchChange}
            searchInputRef={searchInputRef}
            onSearchBarClose={onSearchBarClose}
          />
        ) : null}
        <section className="surface-card surface-card--toolbar-only">
          <div className="section-head section-head--page-toolbar">
            {selectedGenreKey ? (
              <div className="page-toolbar__lead page-toolbar__lead--backrow">
                <button
                  type="button"
                  className="page-toolbar-back-ic"
                  onClick={() => {
                    endSearchForBrowse();
                    setSelectedGenreKey(null);
                  }}
                  aria-label={t("library.backGenresAria")}
                >
                  <UiChevronLeft
                    aria-hidden
                    className="page-toolbar-back-ic__ic"
                  />
                </button>
                <div className="page-toolbar__textcol">
                  <p className="eyebrow">{t("library.genreEyebrow")}</p>
                  <h2>{selectedGenreLabel ?? t("common.emDash")}</h2>
                </div>
              </div>
            ) : (
              <div className="section-head__lead">
                <span className="section-head__icon-wrap" aria-hidden>
                  {libBrowse === "artists" ? (
                    <UiPerson className="section-head__ic" />
                  ) : libBrowse === "genres" ? (
                    <UiStyle className="section-head__ic" />
                  ) : libBrowse === "nebula" ? (
                    <UiAutoAwesome className="section-head__ic" />
                  ) : (
                    <UiPalette className="section-head__ic" />
                  )}
                </span>
                <div className="section-head__text">
                  <p className="eyebrow">{t("library.overviewEyebrow")}</p>
                  <div
                    className="section-nav-tabs"
                    role="group"
                    aria-label={t("library.browseLibrarySectionsAria")}
                  >
                    <button
                      type="button"
                      className={`section-nav-tab${
                        libBrowse === "artists" ? " is-on" : ""
                      }`}
                      onClick={() => {
                        endSearchForBrowse();
                        updateLibBrowse("artists");
                        setSelectedGenreKey(null);
                        setMoodFilterIds([]);
                      }}
                    >
                      {t("library.tabArtists")}
                    </button>
                    <button
                      type="button"
                      className={`section-nav-tab${
                        libBrowse === "genres" ? " is-on" : ""
                      }`}
                      onClick={() => {
                        endSearchForBrowse();
                        updateLibBrowse("genres");
                        setSelectedGenreKey(null);
                        setMoodFilterIds([]);
                      }}
                    >
                      {t("library.tabGenres")}
                    </button>
                    <button
                      type="button"
                      className={`section-nav-tab${
                        libBrowse === "moods" ? " is-on" : ""
                      }`}
                      onClick={() => {
                        endSearchForBrowse();
                        updateLibBrowse("moods");
                        setSelectedGenreKey(null);
                      }}
                    >
                      {t("library.tabMoods")}
                    </button>
                    <button
                      type="button"
                      className={`section-nav-tab${
                        libBrowse === "nebula" ? " is-on" : ""
                      }`}
                      onClick={() => {
                        endSearchForBrowse();
                        updateLibBrowse("nebula");
                        setSelectedGenreKey(null);
                        setMoodFilterIds([]);
                      }}
                    >
                      {t("library.tabNebula")}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="section-head__tools">
              <div className="hero-card__actions">
                {selectedGenreKey ? (
                  <>
                    <PlayCollectionButton
                      label={t("playback.playGenre")}
                      disabled={sortedGenreTracks.length === 0}
                      onClick={() => playPoolShuffle(sortedGenreTracks, true)}
                    />
                    <button
                      type="button"
                      className={`ghost-btn library-toolbar-exclude-btn ${
                        genreToolbarBulkAllExcluded ? "is-on" : ""
                      }`}
                      disabled={tracksInSelectedGenre.length === 0}
                      title={t("library.genreRandomExcludeTitle")}
                      aria-label={t("library.genreRandomExcludeAria")}
                      onClick={() => {
                        if (!tracksInSelectedGenre.length) return;
                        setShuffleTracksExcludedBulk(
                          tracksInSelectedGenre.map((tr) => tr.relPath),
                          !genreToolbarBulkAllExcluded
                        );
                      }}
                    >
                      <ExcludeShuffleIcon className="library-toolbar-exclude-btn__ic" />
                    </button>
                  </>
                ) : libBrowse === "moods" && moodFilterIds.length > 0 ? (
                  <>
                    <PlayCollectionButton
                      label={t("playback.playMood")}
                      disabled={sortedMoodTracks.length === 0}
                      onClick={() => playPoolShuffle(sortedMoodTracks, true)}
                    />
                    <button
                      type="button"
                      className={`ghost-btn library-toolbar-exclude-btn ${
                        moodToolbarBulkAllExcluded ? "is-on" : ""
                      }`}
                      disabled={tracksMatchingMoodFilter.length === 0}
                      title={t("library.genreRandomExcludeTitle")}
                      aria-label={t("library.genreRandomExcludeAria")}
                      onClick={() => {
                        if (!tracksMatchingMoodFilter.length) return;
                        setShuffleTracksExcludedBulk(
                          tracksMatchingMoodFilter.map((tr) => tr.relPath),
                          !moodToolbarBulkAllExcluded
                        );
                      }}
                    >
                      <ExcludeShuffleIcon className="library-toolbar-exclude-btn__ic" />
                    </button>
                  </>
                ) : (
                  <PlayCollectionButton
                    label={t("playback.playLibrary")}
                    disabled={index.tracks.length === 0}
                    onClick={playLibraryShuffle}
                  />
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
      <div className="library-page__body view-page__body">
        <section
          className={`surface-card${
            libBrowse === "nebula" && !selectedGenreKey
              ? " surface-card--nebula"
              : ""
          }`}
        >
          {selectedGenreKey ? (
            <div className="library-filter-panel library-filter-panel--tight library-sort-panel library-genre-tracklist-toolbar">
              <div className="section-head section-head--page-toolbar">
                <div>
                  <p className="eyebrow">{t("library.tracklistEyebrow")}</p>
                  <h2>
                    {selectedGenreAlbumCount}{" "}
                    {selectedGenreAlbumCount === 1
                      ? t("library.unitAlbum")
                      : t("library.unitAlbumPlural")}
                    {" · "}
                    {sortedGenreTracks.length}{" "}
                    {sortedGenreTracks.length === 1
                      ? t("library.unitTrack")
                      : t("library.unitTrackPlural")}
                  </h2>
                </div>
                <div className="section-head__tools">
                  <div
                    className="segmented segmented--joined"
                    role="group"
                    aria-label={t("library.sortOverviewAria")}
                  >
                    <button
                      type="button"
                      className={libOverviewSort === "name" ? "is-on" : ""}
                      onClick={() => updateLibOverviewSort("name")}
                    >
                      <span className="segmented__btn-inner">
                        <UiSortByAlpha className="segmented__ic" aria-hidden />
                        <span>{t("library.sortByName")}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={libOverviewSort === "plays" ? "is-on" : ""}
                      onClick={() => updateLibOverviewSort("plays")}
                    >
                      <span className="segmented__btn-inner">
                        <UiBarChart className="segmented__ic" aria-hidden />
                        <span>{t("library.sortByPlays")}</span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : libBrowse === "artists" || libBrowse === "genres" ? (
            <div
              className={`library-filter-panel library-sort-panel ${
                libBrowse === "artists" || libBrowse === "genres"
                  ? "library-genre-tracklist-toolbar"
                  : ""
              }`}
            >
              {libBrowse === "artists" || libBrowse === "genres" ? (
                <div className="section-head section-head--page-toolbar library-genre-tracklist-headrow">
                  <div>
                    <p className="eyebrow">{t("library.overviewEyebrow")}</p>
                    <h2>
                      {libBrowse === "artists"
                        ? artistsForOverview.length
                        : sortedGenreBrowseList.length}{" "}
                      {libBrowse === "artists"
                        ? artistsForOverview.length === 1
                          ? t("library.unitArtist")
                          : t("library.unitArtistPlural")
                        : sortedGenreBrowseList.length === 1
                        ? t("library.unitGenre")
                        : t("library.unitGenrePlural")}
                    </h2>
                  </div>
                  <div className="section-head__tools library-overview-toolbar">
                    <div
                      className="segmented segmented--joined"
                      role="group"
                      aria-label={t("library.sortOverviewAria")}
                    >
                      <button
                        type="button"
                        className={libOverviewSort === "name" ? "is-on" : ""}
                        onClick={() => updateLibOverviewSort("name")}
                      >
                        <span className="segmented__btn-inner">
                          <UiSortByAlpha className="segmented__ic" aria-hidden />
                          <span>{t("library.sortByName")}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={libOverviewSort === "plays" ? "is-on" : ""}
                        onClick={() => updateLibOverviewSort("plays")}
                      >
                        <span className="segmented__btn-inner">
                          <UiBarChart className="segmented__ic" aria-hidden />
                          <span>{t("library.sortByPlays")}</span>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="library-filter-group">
                  <div
                    className="segmented segmented--joined"
                    role="group"
                    aria-label={t("library.sortOverviewAria")}
                  >
                    <button
                      type="button"
                      className={libOverviewSort === "name" ? "is-on" : ""}
                      onClick={() => updateLibOverviewSort("name")}
                    >
                      <span className="segmented__btn-inner">
                        <UiSortByAlpha className="segmented__ic" aria-hidden />
                        <span>{t("library.sortByName")}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={libOverviewSort === "plays" ? "is-on" : ""}
                      onClick={() => updateLibOverviewSort("plays")}
                    >
                      <span className="segmented__btn-inner">
                        <UiBarChart className="segmented__ic" aria-hidden />
                        <span>{t("library.sortByPlays")}</span>
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {selectedGenreKey ? (
            <>
              <VirtualTrackList
                items={sortedGenreTracks}
                getKey={(track) => track.relPath}
                renderRow={(track, _index, virtualized) => (
                  <TrackListRow
                    key={track.relPath}
                    track={track}
                    autoFocusActive={!virtualized}
                    onPlay={() =>
                      playCollectionShuffle(track, sortedGenreTracks, true)
                    }
                  />
                )}
              />
            </>
          ) : libBrowse === "nebula" ? (
            <div className="library-nebula-embed">
              <Suspense fallback={null}>
                <SonicNebulaView index={index} embedded />
              </Suspense>
            </div>
          ) : libBrowse === "moods" ? (
            <div className="library-mood-browse">
              <div className="library-mood-match-row">
                <span className="library-filter-panel__eyebrow">
                  {t("library.moodMatchEyebrow")}
                </span>
                <div
                  className="segmented segmented--joined"
                  role="group"
                  aria-label={t("library.moodMatchAria")}
                >
                  <button
                    type="button"
                    className={moodMatchMode === "any" ? "is-on" : ""}
                    onClick={() => setMoodMatchMode("any")}
                  >
                    <span className="segmented__btn-inner">
                      <span>{t("library.moodMatchAny")}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={moodMatchMode === "all" ? "is-on" : ""}
                    onClick={() => setMoodMatchMode("all")}
                  >
                    <span className="segmented__btn-inner">
                      <span>{t("library.moodMatchAll")}</span>
                    </span>
                  </button>
                </div>
                {moodFilterIds.length > 0 ? (
                  <button
                    type="button"
                    className="text-btn library-mood-clear"
                    onClick={() => {
                      endSearchForBrowse();
                      setMoodFilterIds([]);
                    }}
                  >
                    {t("library.moodClearFilter")}
                  </button>
                ) : null}
              </div>
              <p className="subtle sm library-mood-explainer">
                {t("library.moodFilterExplainer")}
              </p>
              <div className="library-mood-filter-grid">
                {TRACK_MOOD_IDS.map((id) => {
                  const count = moodOccurrenceCountById.get(id) ?? 0;
                  const on = moodFilterIds.includes(id);
                  const disabled = count === 0 && !on;
                  return (
                    <button
                      type="button"
                      key={id}
                      disabled={disabled}
                      className={`library-mood-filter-btn${
                        on ? " library-mood-filter-btn--on" : ""
                      }`}
                      style={
                        { ["--mood-c"]: TRACK_MOOD_COLORS[id] } as CSSProperties
                      }
                      aria-pressed={on}
                      title={t(`trackMeta.mood.${id}`)}
                      onClick={() => {
                        if (disabled) return;
                        endSearchForBrowse();
                        setMoodFilterIds((prev) =>
                          prev.includes(id)
                            ? prev.filter((x) => x !== id)
                            : [...prev, id]
                        );
                      }}
                    >
                      <span className="library-mood-filter-btn__glyph-row">
                        <TrackMoodGlyph mood={id} />
                        <span className="library-mood-filter-btn__count">
                          {count}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {moodFilterIds.length === 0 ? (
                <p className="panel-empty">{t("library.moodPickHint")}</p>
              ) : sortedMoodTracks.length === 0 ? (
                <p className="panel-empty">{t("library.moodNoTracks")}</p>
              ) : (
                <>
                  <div className="section-head section-head--page-toolbar library-mood-tracklist-head">
                    <div>
                      <p className="eyebrow">{t("library.tracklistEyebrow")}</p>
                      <h2>
                        {sortedMoodTracks.length}{" "}
                        {sortedMoodTracks.length === 1
                          ? t("library.unitTrack")
                          : t("library.unitTrackPlural")}
                      </h2>
                    </div>
                    <div className="section-head__tools">
                      <PlayCollectionButton
                        label={t("playback.playMood")}
                        disabled={sortedMoodTracks.length === 0}
                        onClick={() => playPoolShuffle(sortedMoodTracks, true)}
                      />
                    </div>
                  </div>
                  <VirtualTrackList
                    items={sortedMoodTracks}
                    getKey={(track) => track.relPath}
                    renderRow={(track, _index, virtualized) => (
                      <TrackListRow
                        key={track.relPath}
                        track={track}
                        autoFocusActive={!virtualized}
                        onPlay={() =>
                          playCollectionShuffle(track, sortedMoodTracks, true)
                        }
                      />
                    )}
                  />
                </>
              )}
            </div>
          ) : libBrowse === "artists" ? (
            <VirtualOverviewGrid
              items={artistsForOverview}
              getKey={(item) => item.id}
              onNearEnd={
                paginatedArtists.enabled && paginatedArtists.hasMore
                  ? paginatedArtists.loadMore
                  : undefined
              }
              footer={
                paginatedArtists.enabled && paginatedArtists.hasMore ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={paginatedArtists.loading}
                    onClick={() => paginatedArtists.loadMore()}
                  >
                    {t("common.loadMore")}
                  </button>
                ) : artistsForOverview.length === 0 && index.selectionEmpty ? (
                  <p className="panel-empty">{t("library.selectionEmptyHint")}</p>
                ) : null
              }
              renderItem={(item) => (
                <ArtistListTile
                  artist={item}
                  albumCount={item.albums.length}
                  coverAlbumRelPath={artistCoverById.get(item.id) ?? null}
                  index={index}
                  onOpen={() => onOpenArtist(item.id)}
                />
              )}
            />
          ) : (
            <div className="genre-browse-wrap">
              {genreIndex.noGenreCount > 0 ? (
                <div className="library-overview-cols">
                  <GenreListTile
                    genreKey="__none__"
                    title={t("library.genreCardNoGenre")}
                    albumCount={
                      genreAlbumTrackCounts.get("__none__")?.albums.size ?? 0
                    }
                    trackCount={genreIndex.noGenreCount}
                    albumSlots={genreCoverByKey.get("__none__") ?? []}
                    index={index}
                    muted
                    onOpen={() => {
                      endSearchForBrowse();
                      setSelectedGenreKey("__none__");
                    }}
                  />
                </div>
              ) : null}
              <VirtualOverviewGrid
                items={sortedGenreBrowseList}
                getKey={(g) => g.key}
                renderItem={(g) => (
                  <GenreListTile
                    genreKey={g.key}
                    title={g.label}
                    albumCount={
                      genreAlbumTrackCounts.get(g.key)?.albums.size ?? 0
                    }
                    trackCount={g.count}
                    albumSlots={genreCoverByKey.get(g.key) ?? []}
                    index={index}
                    onOpen={() => {
                      endSearchForBrowse();
                      setSelectedGenreKey(g.key);
                    }}
                  />
                )}
              />
              {genreIndex.list.length === 0 && genreIndex.noGenreCount === 0 ? (
                <p className="panel-empty">{t("library.noGenresEmpty")}</p>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
