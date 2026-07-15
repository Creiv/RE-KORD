import type { useToolsActivity } from "../../../context/ToolsActivityContext";
import type { useI18n } from "../../../i18n/useI18n";
import type { StudioViewProps } from "../types";
import type { StudioPane } from "../../../components/toolsViewShared";

export type StudioToolsActivity = ReturnType<typeof useToolsActivity>;

export type StudioPanelBaseDeps = StudioViewProps & {
  studioPane: StudioPane;
  setStudioPane: (pane: StudioPane) => void;
  tools: StudioToolsActivity;
  t: ReturnType<typeof useI18n>["t"];
  sortLocale: ReturnType<typeof useI18n>["sortLocale"];
};

export type CatalogPickForDownloadFn = (
  pickUrl: string,
  kind: "album" | "song",
) => void;
