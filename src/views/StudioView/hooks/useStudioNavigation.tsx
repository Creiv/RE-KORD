import { useEffect, useMemo, useState } from "react";
import { setVisualSurfaceContext } from "../../../hooks/useVisualSurfaceActive";
import {
  REKORD_STUDIO_PANE,
  STUDIO_PANE_EVENT,
  type StudioPaneId,
} from "../../../context/StudioNavigationContext";
import {
  UiDownload,
  UiImage,
  UiNavHeadphones,
  UiNote,
  UiTrackChanges,
} from "../../../components/RekordUiIcons";
import {
  defaultStudioPane,
  type StudioPane,
} from "../../../components/toolsViewShared";

export function useStudioNavigation() {
  const [studioPane, setStudioPane] = useState<StudioPane>(() => defaultStudioPane());

  useEffect(() => {
    setVisualSurfaceContext({ studioPane });
  }, [studioPane]);

  useEffect(() => {
    try {
      localStorage.setItem(REKORD_STUDIO_PANE, studioPane);
    } catch {
      /* ignore */
    }
  }, [studioPane]);

  useEffect(() => {
    const onPane = (event: Event) => {
      const pane = (event as CustomEvent<StudioPaneId>).detail;
      if (pane) setStudioPane(pane);
    };
    window.addEventListener(STUDIO_PANE_EVENT, onPane);
    return () => window.removeEventListener(STUDIO_PANE_EVENT, onPane);
  }, []);

  const studioOverviewIcon = useMemo(() => {
    switch (studioPane) {
      case "listen":
        return <UiNavHeadphones className="section-head__ic" />;
      case "catalog":
        return <UiTrackChanges className="section-head__ic" />;
      case "download":
        return <UiDownload className="section-head__ic" />;
      case "meta":
        return <UiNote className="section-head__ic" />;
      case "covers":
        return <UiImage className="section-head__ic" />;
      default:
        return <UiTrackChanges className="section-head__ic" />;
    }
  }, [studioPane]);

  return { studioPane, setStudioPane, studioOverviewIcon };
}
