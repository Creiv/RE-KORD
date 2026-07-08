import type { StudioPanelsState } from "./types";
import { UiChevronRight } from "../../components/RekordUiIcons";
import { StudioEntityInfoCard } from "../../components/StudioEntityInfoCard";
type Props = { state: StudioPanelsState };

export function MaintenancePanel({ state: s }: Props) {
  const {
    t,
    library,
    titleSanBusy,
    serverLocalAccess,
    metaAlbumPath,
    metaScanChoiceOpen,
    setMetaScanChoiceOpen,
    metaOptionalOpen,
    setMetaOptionalOpen,
    studioMetaBusy,
    runMetaScanAll,
    runTrackScanAll,
    runSanitizeTitles
  } = s;
  return (
    <>
                <div className="studio-meta-split__secondary">
                  <div className="studio-meta-optional">
                    <button
                      type="button"
                      className="studio-meta-optional__toggle"
                      onClick={() => setMetaOptionalOpen((v) => !v)}
                      aria-expanded={metaOptionalOpen}
                    >
                      <span>{t("tools.metaOptional")}</span>
                      <UiChevronRight
                        className={
                          metaOptionalOpen
                            ? "studio-meta-optional__chev is-open"
                            : "studio-meta-optional__chev"
                        }
                        aria-hidden
                      />
                    </button>
                    {metaOptionalOpen ? (
                      <div className="studio-meta-optional__body studio-action-groups">
                        <div className="studio-action-group">
                          <span className="studio-action-group-label">
                            {t("tools.metaOptionalTitles")}
                          </span>
                          <p className="subtle sm studio-hint-line">
                            {t("tools.titleHint")}
                          </p>
                          <div className="studio-action-row studio-meta-equal-btns">
                            <button
                              type="button"
                              className="ghost-btn"
                              disabled={!metaAlbumPath || studioMetaBusy}
                              onClick={() => runSanitizeTitles("album", true)}
                            >
                              {titleSanBusy ? "…" : t("tools.previewAlbum")}
                            </button>
                            <button
                              type="button"
                              className="primary-btn"
                              disabled={!metaAlbumPath || studioMetaBusy}
                              onClick={() => runSanitizeTitles("album", false)}
                            >
                              {titleSanBusy ? "…" : t("tools.applyAlbum")}
                            </button>
                          </div>
                          {serverLocalAccess ? (
                            <div className="studio-action-row studio-meta-equal-btns">
                              <button
                                type="button"
                                className="ghost-btn"
                                disabled={!library || studioMetaBusy}
                                onClick={() => runSanitizeTitles("all", true)}
                              >
                                {titleSanBusy ? "…" : t("tools.previewLibrary")}
                              </button>
                              <button
                                type="button"
                                className="primary-btn"
                                disabled={!library || studioMetaBusy}
                                onClick={() => runSanitizeTitles("all", false)}
                              >
                                {titleSanBusy ? "…" : t("tools.applyLibrary")}
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <StudioEntityInfoCard artists={library?.artists ?? []} />
                      </div>
                    ) : null}
                  </div>
                </div>

      {metaScanChoiceOpen ? (
        <div
          className="meta-edit-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMetaScanChoiceOpen(null);
          }}
        >
          <div
            className="meta-edit-dialog surface-card studio-scan-choice"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-choice-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h4 className="studio-scan-choice__title" id="scan-choice-title">
              {metaScanChoiceOpen === "album"
                ? t("tools.scanChoiceAlbumTitle")
                : t("tools.scanChoiceTrackTitle")}
            </h4>
            <p className="subtle sm studio-scan-choice__hint">
              {metaScanChoiceOpen === "album"
                ? t("tools.scanChoiceAlbumHint")
                : t("tools.scanChoiceTrackHint")}
            </p>
            <div className="studio-scan-choice__actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  const k = metaScanChoiceOpen;
                  setMetaScanChoiceOpen(null);
                  if (k === "album") void runMetaScanAll(true);
                  else void runTrackScanAll(true);
                }}
              >
                {t("tools.scanChoiceRescanAll")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  const k = metaScanChoiceOpen;
                  setMetaScanChoiceOpen(null);
                  if (k === "album") void runMetaScanAll(false);
                  else void runTrackScanAll(false);
                }}
              >
                {t("tools.scanChoiceMissingOnly")}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setMetaScanChoiceOpen(null)}
              >
                {t("tools.scanChoiceCancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
