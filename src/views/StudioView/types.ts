import type { AppSection } from "../../types";
import type { LibraryReconcileOptions } from "../../lib/libraryReconcile";
import type {
  LibraryEntityDelta,
  LibraryIndex,
  LibraryResponse,
} from "../../types";
import type { useStudioPanels } from "./hooks/useStudioPanels";

export type StudioViewProps = {
  library: LibraryResponse | null;
  libraryIndex: LibraryIndex | null;
  onReconcileLibrary: (opts?: LibraryReconcileOptions) => void | Promise<void>;
  onLibraryDelta?: (delta: LibraryEntityDelta, reconcile?: boolean) => void;
  onLibraryDeltas?: (deltas: LibraryEntityDelta[], reconcile?: boolean) => void;
  onOpenSection?: (section: AppSection) => void;
};

export type StudioPanelsState = ReturnType<typeof useStudioPanels>;
