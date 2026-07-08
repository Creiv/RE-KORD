import type { StudioPanelsState } from "./types";
import { UiChevronRight, UiSearch } from "../../components/RekordUiIcons";
import { StudioDownloadExplore } from "../../components/StudioDownloadExplore";
import { StudioDownloadDisclaimer } from "../../components/StudioDownloadDisclaimer";
import { DlDestFolderGlyph, DlDestUpIcon } from "../../components/toolsViewGlyphs";
import { exploreScopeForItem } from "../../components/toolsViewShared";
import { resolveStudioDownloadOutputDir, studioDownloadKindForScope } from "../../lib/studioDownloadDest";
type Props = { state: StudioPanelsState };

export function DownloadPanel({ state: s }: Props) {
  const {
    t,
    onReconcileLibrary,
    downloadSummaryLine,
    log,
    setLog,
    dlBusy,
    setDlBusy,
    setDlTrackProg,
    mkBusy,
    url,
    setUrl,
    dlStudioMode,
    setDlStudioMode,
    dlUrlMode,
    setDlUrlMode,
    dlList,
    dlDirQuery,
    setDlDirQuery,
    dlDirResults,
    dlDirSearchBusy,
    dlDirSearchOpen,
    dlDirSearchInputRef,
    setDlDirSearchOpen,
    dlPath,
    newDirName,
    setNewDirName,
    relPayload,
    relStreamComplete,
    relEnrichBusy,
    relSel,
    setRelSel,
    relQuery,
    setRelQuery,
    relLoadBusy,
    dlUrlPlaceholder,
    showMultiAlbumPicker,
    filteredRelEntries,
    filteredRelAlbums,
    filteredRelSongs,
    dlUrlValid,
    loadDlFs,
    toggleDlDirSearch,
    doCreateFolder,
    stopStudioDownload,
    hasValidDownloadDest,
    releasesDlBlockedAlbumFolder,
    exploreSingleBlockedArtistFolder,
    prepareExploreDownload,
    runDl,
    loadReleasesCatalog,
    runReleasesDl,
    toggleRelEntry,
    dlMkdirBlockedInAlbum,
    dlProgNorm,
    dlTrackNorm,
    showDualDlProgressBar,
    singleDlBarNorm,
    showDlProgressWrap,
    dlActiveDownloadIdRef
  } = s;
  return (
            <div
              className="studio-pane tools-download"
              role="region"
              aria-label={t("tools.downloadTitle")}
            >
              <div className="studio-panel tools-dl-dest">
                <div className="tools-dl-dest__head">
                  <div className="tools-dl-dest__head-text">
                    <h4 className="studio-panel-title">
                      {t("tools.dlSaveFolder")}
                    </h4>
                    <p className="subtle sm tools-dl-dest__lead">
                      {t("tools.dlDestLead")}
                    </p>
                  </div>
                  <div
                    className="tools-dl-studio-switch tools-dl-dest__mode-switch"
                    role="group"
                    aria-label={t("tools.dlUiModeAria")}
                  >
                    <span
                      className={`tools-dl-studio-switch__label${
                        dlStudioMode === "classic" ? " is-active" : ""
                      }`}
                    >
                      {t("tools.dlUiClassic")}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="tools-dl-studio-switch__track"
                      aria-checked={dlStudioMode === "explore"}
                      aria-label={t("tools.dlUiModeAria")}
                      onClick={() =>
                        setDlStudioMode((m) =>
                          m === "classic" ? "explore" : "classic",
                        )
                      }
                    >
                      <span
                        className="tools-dl-studio-switch__thumb"
                        aria-hidden
                      />
                    </button>
                    <span
                      className={`tools-dl-studio-switch__label${
                        dlStudioMode === "explore" ? " is-active" : ""
                      }`}
                    >
                      {t("tools.dlUiExplore")}
                    </span>
                  </div>
                </div>
                <div className="tools-dl-dest__shell">
                  <div className="tools-dl-dest__pathheader">
                    <p
                      className="tools-dl-dest__label"
                      id="tools-dl-dest-where"
                    >
                      {t("tools.dlPathLabel")}
                    </p>
                    <div className="tools-dl-dest__pathrow">
                      <div className="tools-dl-dest__pathbar">
                        <button
                          type="button"
                          className="tools-dl-dest__up-icon"
                          onClick={() => {
                            if (dlList) loadDlFs(dlList.parent || "");
                          }}
                          disabled={!dlList?.path}
                          title={t("tools.up")}
                          aria-label={t("tools.upFolderAria")}
                        >
                          <DlDestUpIcon />
                        </button>
                        <nav
                          className="breadcrumbs tools-dl-dest__crumbs"
                          aria-labelledby="tools-dl-dest-where"
                        >
                          <button
                            type="button"
                            className="crumb"
                            onClick={() => loadDlFs("")}
                          >
                            {dlList?.musicRoot?.split("/").pop() ||
                              t("tools.musicRoot")}
                          </button>
                          {(dlList?.path || "")
                            .split("/")
                            .filter(Boolean)
                            .map((seg, i, arr) => {
                              const pth = arr.slice(0, i + 1).join("/");
                              return (
                                <span className="tools-dl-dest__bc" key={pth}>
                                  <span
                                    className="tools-dl-dest__bc-sep"
                                    aria-hidden
                                  >
                                    <UiChevronRight className="tools-dl-dest__bc-ic" />
                                  </span>
                                  <button
                                    type="button"
                                    className="crumb"
                                    onClick={() => loadDlFs(pth)}
                                  >
                                    {seg}
                                  </button>
                                </span>
                              );
                            })}
                        </nav>
                      </div>
                      <div
                        className={`tools-dl-dest__search${
                          dlDirSearchOpen ? " is-open" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="tools-dl-dest__search-toggle"
                          onClick={toggleDlDirSearch}
                          aria-label={t("tools.dlFolderSearchAria")}
                          aria-expanded={dlDirSearchOpen}
                          aria-controls="tools-dl-dest-search-field"
                        >
                          <UiSearch className="tools-dl-dest__search-toggle-ic" />
                        </button>
                        <div
                          id="tools-dl-dest-search-field"
                          className="tools-dl-dest__search-field"
                        >
                          <input
                            ref={dlDirSearchInputRef}
                            type="search"
                            className="tools-dl-dest__search-input"
                            value={dlDirQuery}
                            onChange={(e) => setDlDirQuery(e.target.value)}
                            placeholder={t("tools.dlFolderSearchPh")}
                            aria-label={t("tools.dlFolderSearchAria")}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return;
                              setDlDirQuery("");
                              setDlDirSearchOpen(false);
                              dlDirSearchInputRef.current?.blur();
                            }}
                          />
                        </div>
                        {dlDirQuery.trim() ? (
                          <div className="tools-dl-dest__search-results">
                            {dlDirSearchBusy ? (
                              <p className="subtle sm">{t("tools.searching")}</p>
                            ) : dlDirResults.length ? (
                              <ul className="tools-dl-dest__dirlist">
                                {dlDirResults.map((d) => (
                                  <li key={d.relPath}>
                                    <button
                                      type="button"
                                      className="tools-dl-dest__dirbtn"
                                      onClick={() => {
                                        loadDlFs(d.relPath);
                                        setDlDirQuery("");
                                        setDlDirSearchOpen(false);
                                      }}
                                    >
                                      <DlDestFolderGlyph className="tools-dl-dest__dir-ic" />
                                      <span className="tools-dl-dest__dir-name">
                                        {d.relPath}
                                      </span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="subtle sm">
                                {t("tools.dlFolderSearchEmpty")}
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div
                    className="tools-dl-dest__browser"
                    role="group"
                    aria-label={t("tools.dlSubfolders")}
                  >
                    {dlList && dlList.dirs.length === 0 ? (
                      <p className="subtle sm tools-dl-dest__empty">
                        {t("tools.dlEmptyFolders")}
                      </p>
                    ) : null}
                    <ul className="tools-dl-dest__dirlist">
                      {dlList?.dirs.map((d) => (
                        <li key={d.relPath}>
                          <button
                            type="button"
                            className="tools-dl-dest__dirbtn"
                            onClick={() => loadDlFs(d.relPath)}
                          >
                            <DlDestFolderGlyph className="tools-dl-dest__dir-ic" />
                            <span className="tools-dl-dest__dir-name">
                              {d.name}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div
                    className="tools-dl-dest__create"
                    aria-label={
                      dlMkdirBlockedInAlbum
                        ? t("tools.dlMkdirBlockedInAlbum")
                        : t("tools.dlNewSubLabel")
                    }
                  >
                    {dlMkdirBlockedInAlbum ? (
                      <p className="subtle sm tools-dl-dest__mkdir-blocked">
                        {t("tools.dlMkdirBlockedInAlbum")}
                      </p>
                    ) : (
                      <>
                        <p className="tools-dl-dest__label tools-dl-dest__label--inline">
                          {t("tools.dlNewSubLabel")}
                        </p>
                        <div className="tools-dl-dest__newrow">
                          <input
                            type="text"
                            className="tools-dl-dest__newinput"
                            minLength={1}
                            maxLength={200}
                            placeholder={t("tools.newFolderPh")}
                            value={newDirName}
                            onChange={(e) => setNewDirName(e.target.value)}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                newDirName.trim() &&
                                dlList
                              ) {
                                e.preventDefault();
                                doCreateFolder();
                              }
                            }}
                            aria-label={t("tools.newFolderAria")}
                          />
                          <button
                            type="button"
                            className="ghost-btn"
                            disabled={
                              mkBusy || !newDirName.trim() || !dlList
                            }
                            onClick={doCreateFolder}
                          >
                            {mkBusy ? t("tools.creating") : t("tools.createHere")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {hasValidDownloadDest ? (
                    <div className="tools-dl-dest__picked" role="status">
                      {t("tools.destLine", {
                        path: dlPath,
                      })}
                    </div>
                  ) : (
                    <p className="subtle sm warnline tools-dl-dest__warn">
                      {t("tools.confirmFolderWarn")}
                    </p>
                  )}
                </div>
              </div>

              <div className="studio-panel">
                {dlStudioMode === "explore" ? (
                  <StudioDownloadExplore
                    t={t}
                    dlPath={dlPath}
                    singleBlockedArtistFolder={exploreSingleBlockedArtistFolder}
                    resolveOutputDir={(path, item) =>
                      resolveStudioDownloadOutputDir(
                        path,
                        exploreScopeForItem(item),
                        exploreScopeForItem(item) === "playlist"
                          ? item.title
                          : undefined,
                      )
                    }
                    downloadKindForItem={(item) =>
                      studioDownloadKindForScope(exploreScopeForItem(item))
                    }
                    hasValidDownloadDest={hasValidDownloadDest}
                    dlBusy={dlBusy}
                    onBusyChange={setDlBusy}
                    onTrackProgress={setDlTrackProg}
                    onLog={setLog}
                    onReconcileLibrary={onReconcileLibrary}
                    onPrepareDownload={prepareExploreDownload}
                    downloadSummaryLine={downloadSummaryLine}
                    onDownloadIdChange={(id) => {
                      dlActiveDownloadIdRef.current = id;
                    }}
                  />
                ) : (
                  <>
                <h4 className="studio-panel-title">
                  {t("tools.dlLinkSection")}
                </h4>
                <div className="tools-dl-modes">
                  <div className="tools-dl-mode">
                    <div
                      className="tools-dl-mode__seg"
                      role="group"
                      aria-label={t("tools.dlModeHelpAria")}
                    >
                      <button
                        type="button"
                        className={`tools-dl-mode__btn${
                          dlUrlMode === "single" ? " is-on" : ""
                        }`}
                        aria-pressed={dlUrlMode === "single"}
                        onClick={() => setDlUrlMode("single")}
                      >
                        {t("tools.dlTypeSingle")}
                      </button>
                      <button
                        type="button"
                        className={`tools-dl-mode__btn${
                          dlUrlMode === "playlist" ? " is-on" : ""
                        }`}
                        aria-pressed={dlUrlMode === "playlist"}
                        onClick={() => setDlUrlMode("playlist")}
                      >
                        {t("tools.dlTypePlaylist")}
                      </button>
                      <button
                        type="button"
                        className={`tools-dl-mode__btn${
                          dlUrlMode === "releases" ? " is-on" : ""
                        }`}
                        aria-pressed={dlUrlMode === "releases"}
                        onClick={() => setDlUrlMode("releases")}
                      >
                        {t("tools.dlTypeReleases")}
                      </button>
                    </div>
                    <span className="tools-dl-mode__help-wrap">
                      <button
                        type="button"
                        className="tools-dl-mode__help"
                        aria-label={t("tools.dlModeHelpAria")}
                      >
                        ?
                      </button>
                      <span className="tools-dl-mode__tip" role="tooltip">
                        {t("tools.dlModeGuide")}
                      </span>
                    </span>
                  </div>
                </div>
                <input
                  type="url"
                  className="w-full"
                  placeholder={dlUrlPlaceholder}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoComplete="off"
                  aria-invalid={url.trim() !== "" && !dlUrlValid}
                />
                {showMultiAlbumPicker ? (
                  <div className="tools-dl-releases">
                    {relPayload ? (
                      <div className="tools-dl-releases__picks tools-dl-releases__picks--full">
                        <p className="subtle sm">
                          {relPayload.listTitle
                            ? relPayload.listTitle
                            : relPayload.uploader
                            ? t("tools.dlReleasesUploader", {
                                name: relPayload.uploader,
                              })
                            : null}
                        </p>
                        <div className="tools-dl-releases__toolbar">
                          {relPayload.entries.length > 1 ? (
                            <input
                              type="search"
                              className="w-full"
                              value={relQuery}
                              onChange={(e) => setRelQuery(e.target.value)}
                              placeholder={t("tools.dlReleaseSearchPh")}
                              aria-label={t("tools.dlReleaseSearchAria")}
                            />
                          ) : null}
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--sm"
                            onClick={() =>
                              setRelSel(
                                new Set(filteredRelEntries.map((e) => e.id))
                              )
                            }
                          >
                            {t("tools.dlSelectAll")}
                          </button>
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--sm"
                            onClick={() => setRelSel(new Set())}
                          >
                            {t("tools.dlSelectNone")}
                          </button>
                        </div>
                        <div
                          className="tools-dl-releases__sections"
                          aria-busy={!relStreamComplete}
                        >
                          {filteredRelAlbums.length > 0 ? (
                            <section
                              className="tools-dl-releases__section"
                              aria-label={t("tools.catalogWebAlbumsSection")}
                            >
                              <h4 className="tools-dl-releases__section-title">
                                {t("tools.catalogWebAlbumsSection")}
                                <span className="tools-dl-releases__section-count">
                                  {filteredRelAlbums.length}
                                </span>
                              </h4>
                              <ul className="tools-dl-releases__list tools-dl-releases__list--grid">
                                {filteredRelAlbums.map((e) => (
                                  <li
                                    key={e.id}
                                    className="tools-dl-releases__row"
                                  >
                                    <label className="tools-dl-releases__check">
                                      <input
                                        type="checkbox"
                                        checked={relSel.has(e.id)}
                                        onChange={() => toggleRelEntry(e.id)}
                                      />
                                      <span
                                        className="tools-dl-releases__title"
                                        title={e.url}
                                      >
                                        {e.title}
                                      </span>
                                      <span
                                        className={`tools-dl-releases__trackcount${
                                          relEnrichBusy && e.trackCount == null
                                            ? " tools-dl-releases__trackcount--pending"
                                            : ""
                                        }`}
                                        aria-label={
                                          e.trackCount != null
                                            ? t("tools.dlTrackCountAria", {
                                                n: e.trackCount,
                                              })
                                            : relEnrichBusy
                                              ? t(
                                                  "tools.dlTrackCountPendingAria",
                                                )
                                              : undefined
                                        }
                                      >
                                        {e.trackCount != null
                                          ? t("tools.dlTrackCount", {
                                              n: e.trackCount,
                                            })
                                          : relEnrichBusy
                                            ? t("tools.dlTrackCountPending")
                                            : t("tools.dlTrackCountUnknown")}
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ) : null}
                          {filteredRelSongs.length > 0 ? (
                            <section
                              className="tools-dl-releases__section"
                              aria-label={t("tools.catalogWebSongsSection")}
                            >
                              <h4 className="tools-dl-releases__section-title">
                                {t("tools.catalogWebSongsSection")}
                                <span className="tools-dl-releases__section-count">
                                  {filteredRelSongs.length}
                                </span>
                              </h4>
                              <ul className="tools-dl-releases__list tools-dl-releases__list--grid">
                                {filteredRelSongs.map((e) => (
                                  <li
                                    key={e.id}
                                    className="tools-dl-releases__row"
                                  >
                                    <label className="tools-dl-releases__check">
                                      <input
                                        type="checkbox"
                                        checked={relSel.has(e.id)}
                                        onChange={() => toggleRelEntry(e.id)}
                                      />
                                      <span
                                        className="tools-dl-releases__title"
                                        title={e.url}
                                      >
                                        {e.title}
                                      </span>
                                      <span
                                        className={`tools-dl-releases__trackcount${
                                          relEnrichBusy && e.trackCount == null
                                            ? " tools-dl-releases__trackcount--pending"
                                            : ""
                                        }`}
                                        aria-label={
                                          e.trackCount != null
                                            ? t("tools.dlTrackCountAria", {
                                                n: e.trackCount,
                                              })
                                            : relEnrichBusy
                                              ? t(
                                                  "tools.dlTrackCountPendingAria",
                                                )
                                              : undefined
                                        }
                                      >
                                        {e.trackCount != null
                                          ? t("tools.dlTrackCount", {
                                              n: e.trackCount,
                                            })
                                          : relEnrichBusy
                                            ? t("tools.dlTrackCountPending")
                                            : t("tools.dlTrackCountUnknown")}
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ) : null}
                        </div>
                        {relEnrichBusy ? (
                          <p
                            className="subtle sm tools-dl-releases__enrich"
                            role="status"
                          >
                            {t("tools.dlReleasesEnriching")}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="studio-inline-actions studio-inline-actions--spaced tools-dl-actions-row">
                      {!relPayload ? (
                        <button
                          type="button"
                          className="primary-btn"
                          onClick={loadReleasesCatalog}
                          disabled={
                            relLoadBusy ||
                            !url.trim() ||
                            !hasValidDownloadDest ||
                            !dlUrlValid
                          }
                        >
                          {relLoadBusy
                            ? t("tools.dlReleasesLoading")
                            : t("tools.dlLoadReleases")}
                        </button>
                      ) : dlBusy ? (
                        <span className="subtle sm" role="status">
                          {t("tools.inProgress")}
                        </span>
                      ) : (
                        <>
                          <StudioDownloadDisclaimer t={t} />
                          <div className="tools-dl-actions-row__cta">
                            <button
                              type="button"
                              className="primary-btn"
                              onClick={runReleasesDl}
                              disabled={
                                dlBusy ||
                                relLoadBusy ||
                                !hasValidDownloadDest ||
                                relSel.size === 0 ||
                                !relStreamComplete ||
                                !dlUrlValid ||
                                releasesDlBlockedAlbumFolder
                              }
                            >
                              {t("tools.dlDownloadSelected")}
                            </button>
                            {releasesDlBlockedAlbumFolder ? (
                              <p className="subtle sm tools-dl-releases__blocked-hint">
                                {t("tools.dlReleasesBlockedAlbumFolderHint")}
                              </p>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="studio-inline-actions studio-inline-actions--spaced tools-dl-actions-row">
                    {dlBusy ? (
                      <span className="subtle sm" role="status">
                        {t("tools.inProgress")}
                      </span>
                    ) : (
                      <>
                        <StudioDownloadDisclaimer t={t} />
                        <button
                          type="button"
                          className="primary-btn tools-dl-actions-row__cta"
                          onClick={runDl}
                          disabled={
                            dlBusy ||
                            !url.trim() ||
                            !hasValidDownloadDest ||
                            !dlUrlValid
                          }
                        >
                          {t("tools.downloadRun")}
                        </button>
                      </>
                    )}
                  </div>
                )}
                  </>
                )}
                {showDlProgressWrap && (
                  <div
                    className={[
                      "dl-progress-wrap",
                      showDualDlProgressBar ? "dl-progress-wrap--dual" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-live="polite"
                  >
                    {dlBusy ? (
                      <div className="dl-progress-stop-row">
                        <button
                          type="button"
                          className="ghost-btn danger ghost-btn--sm"
                          onClick={stopStudioDownload}
                        >
                          {t("tools.dlStop")}
                        </button>
                      </div>
                    ) : null}
                    {showDualDlProgressBar ? (
                      <>
                        <div className="dl-progress-block">
                          <div className="dl-progress-top">
                            <strong>{t("tools.dlProgressAlbumsLabel")}</strong>
                            <span>
                              {dlBusy
                                ? dlProgNorm
                                  ? t("tools.dlProgressCount", {
                                      cur: dlProgNorm.cur,
                                      tot: dlProgNorm.tot,
                                    })
                                  : t("tools.inProgress")
                                : dlProgNorm
                                ? t("tools.dlProgressCount", {
                                    cur: dlProgNorm.cur,
                                    tot: dlProgNorm.tot,
                                  })
                                : t("common.emDash")}
                            </span>
                          </div>
                          <div className="dl-progress-rail">
                            <div
                              className="dl-progress-fill"
                              style={{
                                width: dlProgNorm
                                  ? `${dlProgNorm.pct}%`
                                  : dlBusy
                                  ? "18%"
                                  : "0%",
                              }}
                            />
                          </div>
                        </div>
                        {dlTrackNorm ? (
                          <div className="dl-progress-block">
                            <div className="dl-progress-top">
                              <strong>
                                {t("tools.dlProgressTracksInAlbum")}
                              </strong>
                              <span>
                                {dlTrackNorm.hasTotal
                                  ? t("tools.dlProgressCount", {
                                      cur: dlTrackNorm.cur,
                                      tot: dlTrackNorm.tot,
                                    })
                                  : t("tools.dlProgressTrackWait")}
                              </span>
                            </div>
                            <div className="dl-progress-rail">
                              <div
                                className="dl-progress-fill"
                                style={{ width: `${dlTrackNorm.pct}%` }}
                              />
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div className="dl-progress-top">
                          <strong>{t("tools.progress")}</strong>
                          <span>
                            {dlBusy
                              ? singleDlBarNorm
                                ? singleDlBarNorm.hasTotal
                                  ? t("tools.dlProgressCount", {
                                      cur: singleDlBarNorm.cur,
                                      tot: singleDlBarNorm.tot,
                                    })
                                  : t("tools.dlProgressTrackWait")
                                : t("tools.inProgress")
                              : singleDlBarNorm
                              ? singleDlBarNorm.hasTotal
                                ? t("tools.dlProgressCount", {
                                    cur: singleDlBarNorm.cur,
                                    tot: singleDlBarNorm.tot,
                                  })
                                : t("tools.dlProgressTrackWait")
                              : t("common.emDash")}
                          </span>
                        </div>
                        <div className="dl-progress-rail">
                          <div
                            className="dl-progress-fill"
                            style={{
                              width: singleDlBarNorm
                                ? `${singleDlBarNorm.pct}%`
                                : dlBusy
                                ? "18%"
                                : "0%",
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="studio-log">
                <label className="subtle sm">{t("tools.logLabel")}</label>
                <textarea
                  className="log"
                  value={log}
                  onChange={(e) => setLog(e.target.value)}
                  rows={4}
                />
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => setLog("")}
                >
                  {t("tools.clear")}
                </button>
              </div>
            </div>
  );
}
