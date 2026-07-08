import { createPortal } from "react-dom";
import {
  AlbumCover,
  LibraryAlbumExcludeChips,
  LibraryAlbumFavoriteChips,
  LibraryAlbumMetaChips,
  TrackListRow,
} from "../../../components/AppSharedUi";
import { AlbumTracklistExpectedMeta } from "../../../components/AlbumTracklistExpectedMeta";
import { EntityInfoAction } from "../../../components/EntityInfoAction";
import { SectionHeadLead } from "../../../components/SectionHeadLead";
import { TrackMetaEditGlyph } from "../../../components/TrackMetaEditor";
import { ExcludeShuffleIcon } from "../../../components/ExcludeShuffleIcon";
import { useOpenAlbumMetaEdit } from "../../../components/AlbumMetaEditor";
import {
  UiAdd,
  UiChevronLeft,
  UiClose,
  UiImage,
  UiMusicNote,
  UiStyle,
} from "../../../components/RekordUiIcons";
import { popoverPlacementStyle } from "../../../hooks/usePopoverLayerAnchored";
import { useI18n } from "../../../i18n/useI18n";
import { fmtDate } from "../../../lib/metaFormat";
import { artistHasOnlyLooseAlbum } from "../../../lib/libraryNav";
import type {
  LibraryAlbumIndex,
  LibraryArtistIndex,
  LibraryIndex,
  LibraryTrackIndex,
} from "../../../types";
import type { useLibraryAlbumDetail } from "../hooks/useLibraryAlbumDetail";

interface LibraryAlbumDetailViewProps {
  index: LibraryIndex;
  artist: LibraryArtistIndex;
  album: LibraryAlbumIndex;
  albumTracks: LibraryTrackIndex[];
  excludedAlbums: Set<string>;
  onOpenArtist: (artist: string) => void;
  toggleShuffleExcludedAlbum: (albumId: string) => void;
  playSequence: (tracks: LibraryTrackIndex[], startIndex: number) => void;
  playAlbumTrackAt: (trIndex: number) => void;
  albumDetail: ReturnType<typeof useLibraryAlbumDetail>;
}

export function LibraryAlbumDetailView({
  index,
  artist,
  album,
  albumTracks,
  excludedAlbums,
  onOpenArtist,
  toggleShuffleExcludedAlbum,
  playSequence,
  playAlbumTrackAt,
  albumDetail,
}: LibraryAlbumDetailViewProps) {
  const { t } = useI18n();
  const openAlbumMetaEdit = useOpenAlbumMetaEdit();

  const {
    coverFileInputRef,
    coverUploadBusy,
    coverUploadErr,
    onCoverFilePicked,
    albumGenrePickerOpen,
    setAlbumGenrePickerOpen,
    albumGenreBusy,
    albumGenreErr,
    albumGenreAnchorRef,
    albumGenreMenuRef,
    albumGenrePlacement,
    albumTrackGenres,
    albumTrackGenreCounts,
    albumGenreOptions,
    addAlbumGenreBySelection,
    applyAlbumGenreToMissingTracks,
    removeAlbumGenre,
  } = albumDetail;

  return (
    <div className="view-page library-page library-view">
      <section className="album-hero">
        <div className="album-hero__body">
          <div className="album-hero__top-band">
            <button
              type="button"
              className={`album-hero__cover-btn${
                coverUploadBusy ? " is-busy" : ""
              }`}
              onClick={() => coverFileInputRef.current?.click()}
              disabled={coverUploadBusy}
              title={t("library.coverUploadTitle")}
              aria-label={t("library.coverUploadAria")}
            >
              <AlbumCover album={album} />
              <span className="album-hero__cover-edit-badge" aria-hidden>
                <UiImage />
              </span>
              {coverUploadErr ? (
                <span className="album-hero__cover-edit-err">
                  {t("library.coverUploadErr")}
                </span>
              ) : null}
            </button>
            <input
              ref={coverFileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = "";
                onCoverFilePicked(file);
              }}
            />
            <div className="album-hero__top-right">
              <div className="section-head section-head--page-toolbar album-hero__toprow">
                <div className="page-toolbar__lead page-toolbar__lead--backrow">
                  <button
                    type="button"
                    className="page-toolbar-back-ic"
                    onClick={() =>
                      artistHasOnlyLooseAlbum(index, artist.id)
                        ? onOpenArtist("")
                        : onOpenArtist(artist.id)
                    }
                    aria-label={t("library.backToArtistAria", {
                      name: artist.name,
                    })}
                  >
                    <UiChevronLeft
                      aria-hidden
                      className="page-toolbar-back-ic__ic"
                    />
                  </button>
                  <div className="page-toolbar__textcol album-hero__toolbar-text">
                    <p className="eyebrow">
                      {t("library.albumDetailEyebrow")}
                    </p>
                    <div className="lib-badge-cluster lib-badge-cluster--toolbar-left">
                      <LibraryAlbumMetaChips album={album} variant="hero" />
                      <LibraryAlbumFavoriteChips
                        album={album}
                        variant="hero"
                      />
                      <LibraryAlbumExcludeChips
                        album={album}
                        variant="hero"
                      />
                    </div>
                  </div>
                </div>
                <div className="section-head__tools">
                  <div className="hero-card__actions">
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => playSequence(albumTracks, 0)}
                    >
                      {t("library.playAlbum")}
                    </button>
                    {album.relPath ? (
                      <EntityInfoAction
                        artistDir={artist.id}
                        albumDir={album.relPath.split("/").slice(1).join("/")}
                        title={album.name}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="ghost-btn ghost-btn--icon-only"
                      onClick={() => openAlbumMetaEdit(album)}
                      title={t("albumMeta.editButton")}
                      aria-label={t("albumMeta.editButton")}
                    >
                      <span className="ghost-btn__meta-ic" aria-hidden>
                        <TrackMetaEditGlyph />
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`ghost-btn library-toolbar-exclude-btn ${
                        excludedAlbums.has(album.id) ? "is-on" : ""
                      }`}
                      onClick={() => toggleShuffleExcludedAlbum(album.id)}
                      title={t("library.randomExcludeBtn")}
                      aria-label={t("library.randomExcludeAria")}
                      aria-pressed={excludedAlbums.has(album.id)}
                    >
                      <ExcludeShuffleIcon className="library-toolbar-exclude-btn__ic" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="album-hero__titleblock">
            <h1 className="album-hero__h1">{album.name}</h1>
          </div>
          <div className="album-hero__meta-full">
            <p className="subtle sm album-hero__title-meta">
              {artist.name}
              {album.releaseDate ? ` · ${fmtDate(album.releaseDate)}` : ""}
              {album.label ? ` · ${album.label}` : ""}
            </p>
            <div className="album-track-genres-inline">
              <div className="meta-edit-genre-chips" role="list">
                {albumTrackGenres.map((g) => {
                  const genreCount =
                    albumTrackGenreCounts.get(g.toLowerCase()) ?? 0;
                  return (
                    <span
                      key={g}
                      className="meta-edit-genre-chip"
                      role="listitem"
                    >
                      <button
                        type="button"
                        className="meta-edit-genre-chip__text meta-edit-genre-chip__browse"
                        disabled={albumGenreBusy}
                        onClick={() => {
                          void applyAlbumGenreToMissingTracks(g);
                        }}
                        title={t("albumMeta.applyGenreMissingTitle", {
                          g,
                          n: genreCount,
                          total: albumTracks.length,
                        })}
                      >
                        {g} ({genreCount})
                      </button>
                      <button
                        type="button"
                        className="meta-edit-genre-chip__x"
                        disabled={albumGenreBusy}
                        onClick={() => {
                          void removeAlbumGenre(g);
                        }}
                        aria-label={t("trackMeta.fieldGenreRemoveAria", {
                          g,
                        })}
                      >
                        <UiClose className="meta-edit-genre-chip__x-ic" />
                      </button>
                    </span>
                  );
                })}
                {albumGenreOptions.length > 0 ? (
                  <div className="meta-edit-genre-add" ref={albumGenreAnchorRef}>
                    <button
                      type="button"
                      className="meta-edit-genre-chip meta-edit-genre-chip--add"
                      disabled={albumGenreBusy}
                      aria-expanded={albumGenrePickerOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAlbumGenrePickerOpen((prev) => !prev);
                      }}
                      aria-label={t("trackMeta.fieldGenreAdd")}
                      title={t("trackMeta.fieldGenreAdd")}
                    >
                      <UiAdd
                        className="meta-edit-genre-chip__add-ic"
                        aria-hidden
                      />
                    </button>
                    {albumGenrePickerOpen
                      ? createPortal(
                          <ul
                            ref={albumGenreMenuRef}
                            className="track-row__overflow-menu meta-edit-genre-option-list popover-layer-fixed"
                            role="menu"
                            style={popoverPlacementStyle(albumGenrePlacement)}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {albumGenreOptions.map((g) => (
                              <li key={g} role="presentation">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="track-row__overflow-item meta-edit-genre-option-item"
                                  onClick={() => {
                                    void addAlbumGenreBySelection(g);
                                  }}
                                >
                                  <span
                                    className="track-row__overflow-item-glyph track-row__ic-glyph--svg"
                                    aria-hidden
                                  >
                                    <UiStyle />
                                  </span>
                                  <span className="track-row__overflow-item-label">
                                    {g}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>,
                          document.body
                        )
                      : null}
                  </div>
                ) : null}
              </div>
              {albumGenreErr ? (
                <p className="subtle sm warnline">{albumGenreErr}</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head section-head--page-toolbar section-head--album-tracklist-head">
          <div className="section-head__album-tracklist-row">
            <SectionHeadLead
              eyebrow={t("library.tracklistEyebrow")}
              title={t("library.tracklistHeading", {
                n: albumTracks.length,
              })}
              icon={<UiMusicNote className="section-head__ic" />}
            />
            <AlbumTracklistExpectedMeta
              album={album}
              presentCount={albumTracks.length}
            />
          </div>
        </div>
        <div className="list-stack">
          {albumTracks.map((track, trIndex) => (
            <TrackListRow
              key={track.relPath}
              track={track}
              playIndex={trIndex}
              onPlayAt={playAlbumTrackAt}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
