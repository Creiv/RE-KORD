import { useCallback, useEffect, useState } from "react";
import { usePlayer } from "../../../context/PlayerContext";
import { useToolsActivity } from "../../../context/ToolsActivityContext";
import { useAppConfirm } from "../../../context/AppConfirmContext";
import { useI18n } from "../../../i18n/useI18n";
import { fetchConfig } from "../../../lib/api";
import { isRekordClientEmbed, type StudioPane } from "../../../components/toolsViewShared";
import type { StudioViewProps } from "../types";
import { useStudioCatalogPanel } from "./useStudioCatalogPanel";
import { useStudioDownloadPanel } from "./useStudioDownloadPanel";
import { useStudioEnrichmentPanel } from "./useStudioEnrichmentPanel";

export function useStudioPanels(
  {
    library,
    libraryIndex,
    onReconcileLibrary,
    onLibraryDelta,
    onLibraryDeltas,
  }: StudioViewProps,
  studioPane: StudioPane,
  setStudioPane: (pane: StudioPane) => void,
) {
  const p = usePlayer();
  const { t, sortLocale } = useI18n();
  const { confirm: appConfirm } = useAppConfirm();
  const tools = useToolsActivity();

  const [catalogLockedByEnv, setCatalogLockedByEnv] = useState(false);
  const [serverLocalAccess, setServerLocalAccess] = useState(false);
  const [discogsConfigured, setDiscogsConfigured] = useState(false);

  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setCatalogLockedByEnv(c.lockedByEnv);
        setServerLocalAccess(Boolean(c.localAccess) && !isRekordClientEmbed());
        setDiscogsConfigured(Boolean(c.discogsConfigured));
      })
      .catch(() => {});
  }, []);

  const baseDeps = {
    library,
    libraryIndex,
    onReconcileLibrary,
    onLibraryDelta,
    onLibraryDeltas,
    studioPane,
    setStudioPane,
    tools,
    t,
    sortLocale,
  };

  const download = useStudioDownloadPanel({ ...baseDeps, appConfirm });
  const catalog = useStudioCatalogPanel({
    ...baseDeps,
    catalogLockedByEnv,
    serverLocalAccess,
  });
  const enrich = useStudioEnrichmentPanel({
    ...baseDeps,
    p,
    appConfirm,
    discogsConfigured,
  });

  const { bridgePickForDownload, ...downloadState } = download;

  const pickCatalogWebForDownload = useCallback(
    (pickUrl: string, kind: "album" | "song") => {
      const trimmed = pickUrl.trim();
      if (!trimmed) return;
      bridgePickForDownload(trimmed, kind);
      setStudioPane("download");
    },
    [bridgePickForDownload, setStudioPane],
  );

  return {
    t,
    sortLocale,
    p,
    studioPane,
    setStudioPane,
    library,
    libraryIndex,
    onReconcileLibrary,
    onLibraryDelta,
    onLibraryDeltas,
    ...downloadState,
    ...catalog,
    ...enrich,
    pickCatalogWebForDownload,
  };
}
