import type { StudioPanelsState } from "./types";
import { UiChevronLeft } from "../../components/RekordUiIcons";
import { StudioCatalogAlbumTile, StudioCatalogArtistTile } from "../../components/library";
import { StudioCatalogWeb } from "../../components/StudioCatalogWeb";
import { catalogArtistCoverRel, indexHasAlbum, indexHasArtist, selectionHasAlbum, selectionHasArtist } from "../../components/toolsViewShared";
type Props = { state: StudioPanelsState };

export function CatalogPanel({ state: s }: Props) {
  const {
    t,
    studioPane,
    libraryIndex,
    catalogStudioMode,
    setCatalogStudioMode,
    catalogLockedByEnv,
    catalogData,
    mySelection,
    catalogBusy,
    catalogErr,
    catalogMsg,
    catalogArtistDetail,
    setCatalogArtistDetail,
    catalogArtistQuery,
    setCatalogArtistQuery,
    catalogArtistOnlyAttention,
    setCatalogArtistOnlyAttention,
    loadCatalogPane,
    openCatalogArtist,
    pickCatalogWebForDownload,
    addArtistCatalog,
    removeArtistCatalog,
    addAlbumCatalog,
    removeAlbumCatalog,
    filteredCatalogArtists
  } = s;
  return (
            <div
              className="studio-pane studio-catalog-pane"
              role="region"
              aria-label={t("tools.catalogTitle")}
            >
              <div className="studio-catalog-browse">
                <div className="studio-catalog-head">
                  <p className="subtle sm studio-catalog-browse-lead">
                    {catalogStudioMode === "web"
                      ? t("tools.catalogWebDesc")
                      : t("tools.catalogDesc")}
                  </p>
                  <div
                    className="tools-dl-studio-switch studio-catalog-head__mode-switch"
                    role="group"
                    aria-label={t("tools.catalogUiModeAria")}
                  >
                    <span
                      className={`tools-dl-studio-switch__label${
                        catalogStudioMode === "local" ? " is-active" : ""
                      }`}
                    >
                      {t("tools.catalogUiLocal")}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="tools-dl-studio-switch__track"
                      aria-checked={catalogStudioMode === "web"}
                      aria-label={t("tools.catalogUiModeAria")}
                      onClick={() =>
                        setCatalogStudioMode((m) => {
                          const next = m === "local" ? "web" : "local";
                          if (next === "web") setCatalogArtistDetail(null);
                          return next;
                        })
                      }
                    >
                      <span
                        className="tools-dl-studio-switch__thumb"
                        aria-hidden
                      />
                    </button>
                    <span
                      className={`tools-dl-studio-switch__label${
                        catalogStudioMode === "web" ? " is-active" : ""
                      }`}
                    >
                      {t("tools.catalogUiWeb")}
                    </span>
                  </div>
                </div>
                {catalogStudioMode === "web" ? (
                  <StudioCatalogWeb
                    t={t}
                    active={studioPane === "catalog"}
                    onPickForDownload={pickCatalogWebForDownload}
                  />
                ) : (
                  <>
                {catalogLockedByEnv ? (
                  <p className="subtle sm warnline">
                    {t("tools.catalogEnvLock")}
                  </p>
                ) : null}
                {!catalogLockedByEnv ? (
                  <div className="studio-catalog-toolbar">
                    <div className="studio-catalog-toolbar__row">
                      <button
                        type="button"
                        className="primary-btn primary-btn--sm"
                        onClick={() => loadCatalogPane(true)}
                        disabled={catalogBusy}
                      >
                        {catalogBusy
                          ? t("tools.catalogLoading")
                          : t("tools.catalogReload")}
                      </button>
                      {catalogData && !catalogArtistDetail ? (
                        <input
                          type="search"
                          className="ghost-input ghost-input--search studio-catalog-toolbar__search"
                          value={catalogArtistQuery}
                          onChange={(e) => setCatalogArtistQuery(e.target.value)}
                          placeholder={t("tools.catalogSearchPlaceholder")}
                          aria-label={t("tools.catalogSearchAria")}
                        />
                      ) : null}
                    </div>
                    {catalogData && !catalogArtistDetail ? (
                      <label className="studio-catalog-toolbar__check">
                        <input
                          type="checkbox"
                          checked={catalogArtistOnlyAttention}
                          onChange={(e) =>
                            setCatalogArtistOnlyAttention(e.target.checked)
                          }
                        />
                        <span>{t("tools.catalogFilterNeedsAttention")}</span>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {mySelection?.includeAll ? (
                  <p className="subtle sm">{t("tools.catalogIncludeAll")}</p>
                ) : null}
                {catalogData ? (
                  <>
                    {catalogArtistDetail ? (
                      <>
                        <div className="section-head section-head--page-toolbar">
                          <div className="page-toolbar__lead page-toolbar__lead--backrow">
                            <button
                              type="button"
                              className="page-toolbar-back-ic"
                              onClick={() => setCatalogArtistDetail(null)}
                              aria-label={t("tools.catalogBackArtists")}
                            >
                              <UiChevronLeft
                                aria-hidden
                                className="page-toolbar-back-ic__ic"
                              />
                            </button>
                            <div className="page-toolbar__textcol">
                              <p className="eyebrow">{t("tools.catalogTabAlbums")}</p>
                              <h2>{catalogArtistDetail.name}</h2>
                            </div>
                          </div>
                        </div>
                        <div className="library-overview-cols">
                          {catalogArtistDetail.relAlbums.map((al) => {
                            const inIndex = indexHasAlbum(
                              libraryIndex,
                              al.relPath,
                            );
                            const sel = selectionHasAlbum(
                              mySelection,
                              al.relPath,
                              catalogArtistDetail.id,
                            );
                            return (
                              <StudioCatalogAlbumTile
                                key={al.relPath}
                                album={al}
                                artistName={catalogArtistDetail.name}
                                inLibraryIndex={inIndex}
                                inSelection={sel}
                                catalogBusy={catalogBusy}
                                selectionIncludeAll={
                                  Boolean(mySelection?.includeAll)
                                }
                                onAddToLibrary={() => addAlbumCatalog(al.relPath)}
                                onRemoveFromLibrary={() =>
                                  removeAlbumCatalog(al.relPath)
                                }
                                addLabel={t("tools.catalogAddLibrary")}
                                removeLabel={t("tools.catalogRemoveLibrary")}
                              />
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        {filteredCatalogArtists.length === 0 &&
                        catalogData.artists.length > 0 ? (
                          <p className="subtle sm studio-catalog-filter-empty">
                            {t("tools.catalogFilterEmpty")}
                          </p>
                        ) : (
                          <div className="library-overview-cols">
                            {filteredCatalogArtists.map((ar) => {
                              const coverRel = catalogArtistCoverRel(ar);
                              const inIndex = indexHasArtist(
                                libraryIndex,
                                ar.id,
                              );
                              const sel = selectionHasArtist(
                                mySelection,
                                ar.id,
                              );
                              return (
                                <StudioCatalogArtistTile
                                  key={ar.id}
                                  artist={ar}
                                  coverRelPath={coverRel}
                                  inLibraryIndex={inIndex}
                                  inSelection={sel}
                                  catalogBusy={catalogBusy}
                                  selectionIncludeAll={Boolean(
                                    mySelection?.includeAll,
                                  )}
                                  onOpen={() => openCatalogArtist(ar.id)}
                                  onAddToLibrary={() => addArtistCatalog(ar.id)}
                                  onRemoveFromLibrary={() =>
                                    removeArtistCatalog(ar.id)
                                  }
                                  addLabel={t("tools.catalogAddLibrary")}
                                  removeLabel={t("tools.catalogRemoveLibrary")}
                                />
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </>
                ) : null}
                {catalogMsg ? <p className="subtle sm">{catalogMsg}</p> : null}
                {catalogErr ? (
                  <p className="subtle sm warnline">{catalogErr}</p>
                ) : null}
                  </>
                )}
              </div>
            </div>
  );
}
