import { lazy, Suspense, useEffect } from "react";
import { useI18n } from "../../i18n/useI18n";
import { ViewErrorBoundary } from "../../components/ViewErrorBoundary";
import type { StudioViewProps } from "./types";
import { useStudioNavigation } from "./hooks/useStudioNavigation";
import { useStudioLibrarySync } from "./hooks/useStudioLibrarySync";
import { useStudioPanels } from "./hooks/useStudioPanels";
import { CatalogPanel } from "./CatalogPanel";
import { DownloadPanel } from "./DownloadPanel";
import { EnrichPanel } from "./EnrichPanel";
import { MaintenancePanel } from "./MaintenancePanel";
import { AlbumEditorPanel } from "./AlbumEditorPanel";

const LazyListenView = lazy(() => import("../ListenView/ListenView"));

export function StudioView(props: StudioViewProps) {
  const { t } = useI18n();
  const { studioPane, setStudioPane, studioOverviewIcon } =
    useStudioNavigation();
  useStudioLibrarySync();
  const panels = useStudioPanels(props, studioPane, setStudioPane);

  useEffect(() => {
    if (studioPane !== "listen" || props.libraryIndex) return;
    const t = window.setTimeout(() => {
      setStudioPane("catalog");
    }, 1200);
    return () => window.clearTimeout(t);
  }, [studioPane, props.libraryIndex, setStudioPane]);

  const listenReady = studioPane === "listen" && props.libraryIndex;
  const listenWaiting = studioPane === "listen" && !props.libraryIndex;

  return (
    <>
      <section className="surface-card surface-card--toolbar-only">
        <div className="section-head section-head--page-toolbar">
          <div className="section-head__lead">
            <span className="section-head__icon-wrap" aria-hidden>
              {studioOverviewIcon}
            </span>
            <div className="section-head__text">
              <p className="eyebrow">{t("tools.studioOverviewEyebrow")}</p>
              <div
                className="section-nav-tabs"
                role="group"
                aria-label={t("tools.studioPaneAria")}
              >
                <button
                  type="button"
                  className={`section-nav-tab${
                    studioPane === "listen" ? " is-on" : ""
                  }`}
                  onClick={() => setStudioPane("listen")}
                >
                  {t("tools.studioTabListen")}
                </button>
                <button
                  type="button"
                  className={`section-nav-tab${
                    studioPane === "catalog" ? " is-on" : ""
                  }`}
                  onClick={() => setStudioPane("catalog")}
                >
                  {t("tools.studioTabCatalog")}
                </button>
                <button
                  type="button"
                  className={`section-nav-tab${
                    studioPane === "download" ? " is-on" : ""
                  }`}
                  onClick={() => setStudioPane("download")}
                >
                  {t("tools.studioTabDownload")}
                </button>
                <button
                  type="button"
                  className={`section-nav-tab${
                    studioPane === "meta" ? " is-on" : ""
                  }`}
                  onClick={() => setStudioPane("meta")}
                >
                  {t("tools.studioTabMeta")}
                </button>
                <button
                  type="button"
                  className={`section-nav-tab${
                    studioPane === "covers" ? " is-on" : ""
                  }`}
                  onClick={() => setStudioPane("covers")}
                >
                  {t("tools.studioTabCovers")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className={
          studioPane === "listen"
            ? "studio-listen-shell"
            : "surface-card studio-page-card"
        }
      >
        <div className="tools tool-studio-layout">
          {listenReady ? (
            <div
              className="studio-pane studio-pane--listen"
              role="region"
              aria-label={t("tools.studioTabListen")}
            >
              <ViewErrorBoundary label="Ascolta">
                <Suspense fallback={<p className="subtle sm">{t("loading.app")}</p>}>
                  <LazyListenView
                    index={props.libraryIndex!}
                    onOpenSection={props.onOpenSection ?? (() => {})}
                    onLibraryDelta={props.onLibraryDelta}
                  />
                </Suspense>
              </ViewErrorBoundary>
            </div>
          ) : null}
          {listenWaiting ? (
            <div className="studio-pane studio-pane--listen studio-pane--loading" role="status">
              <p className="subtle sm">{t("loading.app")}</p>
            </div>
          ) : null}
          {studioPane === "catalog" ? (
            <CatalogPanel state={panels} />
          ) : null}
          {studioPane === "download" ? (
            <DownloadPanel state={panels} />
          ) : null}
          {studioPane === "meta" ? (
            <div
              className="studio-pane tools-meta"
              role="region"
              aria-label={t("tools.metaTitle")}
            >
              <div className="studio-meta-split">
                <EnrichPanel state={panels} />
                <MaintenancePanel state={panels} />
              </div>
            </div>
          ) : null}
          {studioPane === "covers" ? (
            <AlbumEditorPanel state={panels} />
          ) : null}
        </div>
      </section>
    </>
  );
}

export default StudioView;
