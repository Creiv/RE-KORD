import type { StudioPanelsState } from "./types";
type Props = { state: StudioPanelsState };

export function EnrichPanel({ state: s }: Props) {
  const {
    t,
    p,
    library,
    metaLog,
    setMetaLog,
    metaBusy,
    metaAllBusy,
    metaScanProg,
    trackMetaBusy,
    trackAllBusy,
    trackScanProg,
    trackPruneBusy,
    trackPruneProg,
    stopMetaAll,
    stopTrackAll,
    stopTrackPrune,
    metaArtistName,
    setMetaArtistName,
    metaAlbumPath,
    setMetaAlbumPath,
    setMetaArt,
    setMetaAlb,
    setMetaScanChoiceOpen,
    discogsPickerOpen,
    setDiscogsPickerOpen,
    discogsCandidates,
    libraryArtistsSorted,
    studioMetaBusy,
    metaAlbumsForPick,
    setMetaFromCurrent,
    fetchOneAlbumMeta,
    applyDiscogsReleaseChoice,
    fetchSelectedAlbumTracksMeta,
    runPruneOrphanTrackMeta
  } = s;
  const stopMetaAllRef = stopMetaAll;
  const stopTrackAllRef = stopTrackAll;
  const stopTrackPruneRef = stopTrackPrune;
  return (
    <>
                <div className="studio-meta-split__primary">
                  <div className="studio-panel studio-meta-picks">
                    <div className="studio-picker-picks tools-studio-pair-picks">
                      <div>
                        <label
                          className="subtle sm block-label"
                          htmlFor="meta-artist-sel"
                        >
                          {t("tools.pickerArtist")}
                        </label>
                        <select
                          id="meta-artist-sel"
                          className="select"
                          value={metaArtistName}
                          onChange={(e) => {
                            const v = e.target.value;
                            setMetaArtistName(v);
                            setMetaAlbumPath("");
                          }}
                          aria-label={t("tools.pickerArtist")}
                        >
                          <option value="">
                            {t("tools.pickerPlaceholder")}
                          </option>
                          {libraryArtistsSorted.map((a) => (
                            <option key={a.name} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          className="subtle sm block-label"
                          htmlFor="meta-album-sel"
                        >
                          {t("tools.pickerAlbum")}
                        </label>
                        <select
                          id="meta-album-sel"
                          className="select"
                          value={metaAlbumPath}
                          onChange={(e) => {
                            const v = e.target.value;
                            setMetaAlbumPath(v);
                            const o = metaAlbumsForPick.find(
                              (x) => x.relPath === v
                            );
                            if (o) {
                              setMetaArt(metaArtistName);
                              setMetaAlb(o.name);
                            }
                          }}
                          disabled={!metaArtistName}
                          aria-label={t("tools.metaAlbumAria")}
                        >
                          {!metaArtistName ? (
                            <option value="">
                              {t("tools.pickerAlbumNeedArtist")}
                            </option>
                          ) : (
                            <>
                              <option value="">{t("tools.pickAlbum")}</option>
                              {metaAlbumsForPick.map((o) => (
                                <option key={o.relPath} value={o.relPath}>
                                  {o.name}
                                </option>
                              ))}
                            </>
                          )}
                        </select>
                      </div>
                    </div>
                    {metaAlbumPath ? (
                      <p className="art-target sm">
                        {t("tools.folderLine", { path: metaAlbumPath })}
                      </p>
                    ) : null}
                    <div className="studio-action-row studio-meta-fill-row">
                      <button
                        type="button"
                        className="ghost-btn ghost-btn--sm"
                        onClick={setMetaFromCurrent}
                        disabled={!p.current || studioMetaBusy}
                      >
                        {t("tools.metaFillFromPlayback")}
                      </button>
                    </div>
                  </div>

                  <div className="studio-panel studio-meta-essentials">
                    <h4 className="studio-panel-title">
                      {t("tools.metaEssentials")}
                    </h4>
                    <div className="studio-action-groups">
                      <div className="studio-action-group">
                        <span className="studio-action-group-label">
                          {t("tools.metaAlbumSectionLabel")}
                        </span>
                        <p className="subtle sm studio-meta-essentials-hint">
                          {t("tools.metaEssentialsAlbumSub")}
                        </p>
                        <div className="studio-action-row studio-meta-equal-btns">
                          <button
                            type="button"
                            className="primary-btn"
                            onClick={fetchOneAlbumMeta}
                            disabled={!metaAlbumPath?.trim() || studioMetaBusy}
                          >
                            {metaBusy
                              ? t("tools.fetchingMeta")
                              : t("tools.metaBtnSelectedAlbum")}
                          </button>
                          <button
                            type="button"
                            className="ghost-btn"
                            onClick={() => setMetaScanChoiceOpen("album")}
                            disabled={!library || studioMetaBusy}
                            title={t("tools.scanAlbumsTitle")}
                          >
                            {metaAllBusy
                              ? t("tools.scanning")
                              : t("tools.metaBtnScanAuto")}
                          </button>
                        </div>
                      </div>
                      <div className="studio-action-group">
                        <span className="studio-action-group-label">
                          {t("tools.tracks")}
                        </span>
                        <p className="subtle sm studio-meta-essentials-hint">
                          {t("tools.metaEssentialsTracksSub")}
                        </p>
                        <div className="studio-action-row studio-meta-equal-btns">
                          <button
                            type="button"
                            className="primary-btn"
                            onClick={fetchSelectedAlbumTracksMeta}
                            disabled={!metaAlbumPath?.trim() || studioMetaBusy}
                          >
                            {trackMetaBusy
                              ? "…"
                              : t("tools.selectedAlbumTracksMeta")}
                          </button>
                          <button
                            type="button"
                            className="ghost-btn"
                            onClick={() => setMetaScanChoiceOpen("track")}
                            disabled={!library || studioMetaBusy}
                          >
                            {trackAllBusy
                              ? t("tools.scanning")
                              : t("tools.scanAllTracks")}
                          </button>
                        </div>
                      </div>
                    </div>
                    {metaAllBusy && metaScanProg && metaScanProg.total > 0 ? (
                      <div className="dl-progress-wrap">
                        <div className="dl-progress-top">
                          <span>{t("tools.progressAlbumMeta")}</span>
                          <span>
                            {metaScanProg.current}/{metaScanProg.total}
                          </span>
                        </div>
                        <div className="dl-progress-rail">
                          <div
                            className="dl-progress-fill"
                            style={{
                              width: `${Math.max(
                                2,
                                Math.min(
                                  100,
                                  (metaScanProg.current / metaScanProg.total) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {trackAllBusy &&
                    trackScanProg &&
                    trackScanProg.total > 0 ? (
                      <div className="dl-progress-wrap">
                        <div className="dl-progress-top">
                          <span>{t("tools.progressTrackMeta")}</span>
                          <span>
                            {trackScanProg.current}/{trackScanProg.total}
                          </span>
                        </div>
                        <div className="dl-progress-rail">
                          <div
                            className="dl-progress-fill"
                            style={{
                              width: `${Math.max(
                                2,
                                Math.min(
                                  100,
                                  (trackScanProg.current /
                                    trackScanProg.total) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {trackPruneBusy &&
                    trackPruneProg &&
                    trackPruneProg.total > 0 ? (
                      <div className="dl-progress-wrap">
                        <div className="dl-progress-top">
                          <span>{t("tools.progressTrackMetaPrune")}</span>
                          <span>
                            {trackPruneProg.current}/{trackPruneProg.total}
                          </span>
                        </div>
                        <div className="dl-progress-rail">
                          <div
                            className="dl-progress-fill"
                            style={{
                              width: `${Math.max(
                                2,
                                Math.min(
                                  100,
                                  (trackPruneProg.current /
                                    trackPruneProg.total) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {(metaAllBusy || trackAllBusy || trackPruneBusy) && (
                      <div className="studio-stop-row">
                        {metaAllBusy ? (
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--sm"
                            onClick={() => {
                              stopMetaAllRef.current = true;
                            }}
                          >
                            {t("tools.stopAlbums")}
                          </button>
                        ) : null}
                        {trackAllBusy ? (
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--sm"
                            onClick={() => {
                              stopTrackAllRef.current = true;
                            }}
                          >
                            {t("tools.stopTracks")}
                          </button>
                        ) : null}
                        {trackPruneBusy ? (
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--sm"
                            onClick={() => {
                              stopTrackPruneRef.current = true;
                            }}
                          >
                            {t("tools.stopTrackPrune")}
                          </button>
                        ) : null}
                      </div>
                    )}
                    <div className="studio-meta-if-needed">
                      <button
                        type="button"
                        className="ghost-btn ghost-btn--sm"
                        onClick={() => {
                          void runPruneOrphanTrackMeta();
                        }}
                        disabled={!library || studioMetaBusy}
                        title={t("tools.trackMetaPruneTitle")}
                      >
                        {trackPruneBusy
                          ? "…"
                          : t("tools.trackMetaPruneOrphans")}
                      </button>
                    </div>
                  </div>

                  <div className="studio-log">
                    <label className="subtle sm">{t("tools.logLabel")}</label>
                    <textarea
                      className="log"
                      value={metaLog}
                      onChange={(e) => setMetaLog(e.target.value)}
                      rows={3}
                    />
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setMetaLog("")}
                    >
                      {t("tools.clear")}
                    </button>
                  </div>
                </div>

      {discogsPickerOpen ? (
        <div
          className="meta-edit-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDiscogsPickerOpen(false);
          }}
        >
          <div
            className="meta-edit-dialog surface-card studio-discogs-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discogs-picker-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="section-head">
              <div>
                <h2 id="discogs-picker-title">{t("tools.discogsPickerTitle")}</h2>
                <p className="subtle sm">{t("tools.discogsPickerHint")}</p>
              </div>
              <button
                type="button"
                className="text-btn"
                onClick={() => setDiscogsPickerOpen(false)}
              >
                {t("tools.discogsPickerCancel")}
              </button>
            </div>
            <ul className="studio-discogs-picker__list">
              {discogsCandidates.map((c) => (
                <li key={c.releaseId}>
                  <button
                    type="button"
                    className="studio-discogs-picker__item"
                    onClick={() => applyDiscogsReleaseChoice(c.releaseId)}
                  >
                    {c.thumb ? (
                      <img
                        src={c.thumb}
                        alt=""
                        className="studio-discogs-picker__thumb"
                      />
                    ) : null}
                    <span className="studio-discogs-picker__body">
                      <span className="studio-discogs-picker__title">
                        {c.title}
                      </span>
                      <span className="subtle sm">
                        {[c.year, c.country, c.format, c.label, c.catno]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {c.community.have != null || c.community.want != null ? (
                        <span className="subtle sm">
                          {t("tools.discogsCommunity", {
                            have: String(c.community.have ?? "—"),
                            want: String(c.community.want ?? "—"),
                          })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
