import { PlayCollectionButton } from "../../../components/PlayCollectionButton";
import { AlbumListTile } from "../../../components/library";
import { EntityInfoAction } from "../../../components/EntityInfoAction";
import {
  UiBarChart,
  UiChevronLeft,
  UiDateRange,
  UiSortByAlpha,
} from "../../../components/RekordUiIcons";
import { useI18n } from "../../../i18n/useI18n";
import type {
  LibraryAlbumIndex,
  LibraryArtistIndex,
  LibraryTrackIndex,
} from "../../../types";

interface LibraryArtistDetailViewProps {
  artist: LibraryArtistIndex;
  artistAlbums: LibraryAlbumIndex[];
  artistAlbumSort: "date" | "name" | "plays";
  artistShuffleEligible: LibraryTrackIndex[];
  onOpenArtist: (artist: string) => void;
  onOpenAlbum: (artist: string, album: string) => void;
  updateArtistAlbumSort: (sort: "date" | "name" | "plays") => void;
  playArtistShuffle: () => void;
}

export function LibraryArtistDetailView({
  artist,
  artistAlbums,
  artistAlbumSort,
  artistShuffleEligible,
  onOpenArtist,
  onOpenAlbum,
  updateArtistAlbumSort,
  playArtistShuffle,
}: LibraryArtistDetailViewProps) {
  const { t } = useI18n();

  return (
    <div className="view-page library-page library-view">
      <section className="surface-card surface-card--toolbar-only">
        <div className="section-head section-head--page-toolbar">
          <div className="page-toolbar__lead page-toolbar__lead--backrow">
            <button
              type="button"
              className="page-toolbar-back-ic"
              onClick={() => onOpenArtist("")}
              aria-label={t("library.backAllArtistsAria")}
            >
              <UiChevronLeft
                aria-hidden
                className="page-toolbar-back-ic__ic"
              />
            </button>
            <div className="page-toolbar__textcol">
              <p className="eyebrow">{t("library.artistEyebrow")}</p>
              <h2>{artist.name}</h2>
            </div>
          </div>
          <div className="section-head__tools">
            <div className="hero-card__actions">
              <PlayCollectionButton
                label={t("playback.playArtist")}
                disabled={artistShuffleEligible.length === 0}
                onClick={playArtistShuffle}
              />
              <EntityInfoAction artistDir={artist.id} title={artist.name} />
            </div>
          </div>
        </div>
      </section>
      <section className="surface-card">
        <div className="library-filter-panel library-sort-panel library-genre-tracklist-toolbar">
          <div className="section-head section-head--page-toolbar library-genre-tracklist-headrow">
            <div>
              <p className="eyebrow">{t("library.overviewEyebrow")}</p>
              <h2>
                {artistAlbums.length}{" "}
                {artistAlbums.length === 1
                  ? t("library.unitAlbumFound")
                  : t("library.unitAlbumFoundPlural")}
              </h2>
            </div>
            <div className="section-head__tools library-overview-toolbar">
              <div
                className="segmented segmented--joined"
                role="group"
                aria-label={t("library.artistAlbumsSortAria")}
              >
                <button
                  type="button"
                  className={artistAlbumSort === "date" ? "is-on" : ""}
                  onClick={() => updateArtistAlbumSort("date")}
                >
                  <span className="segmented__btn-inner">
                    <UiDateRange className="segmented__ic" aria-hidden />
                    <span>{t("library.sortDate")}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={artistAlbumSort === "name" ? "is-on" : ""}
                  onClick={() => updateArtistAlbumSort("name")}
                >
                  <span className="segmented__btn-inner">
                    <UiSortByAlpha className="segmented__ic" aria-hidden />
                    <span>{t("library.sortName")}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={artistAlbumSort === "plays" ? "is-on" : ""}
                  onClick={() => updateArtistAlbumSort("plays")}
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
        <div className="library-overview-cols">
          {artistAlbums.map((item) => (
            <AlbumListTile
              key={item.id}
              album={item}
              onOpen={() => onOpenAlbum(artist.id, item.name)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
