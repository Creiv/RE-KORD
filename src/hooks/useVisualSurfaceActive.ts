import type { StudioPane } from "../components/toolsViewShared";
import type { AppSection, UserSettings } from "../types";

export type NebulaSurface = "dashboard" | "library";

type VisualSurfaceContext = {
  section: AppSection;
  libBrowse: UserSettings["libBrowse"];
  studioPane: StudioPane;
};

let ctx: VisualSurfaceContext = {
  section: "dashboard",
  libBrowse: "artists",
  studioPane: "listen",
};

const listeners = new Set<() => void>();

/** Aggiorna contesto tab/sezione per pausa canvas fuori vista. */
export function setVisualSurfaceContext(
  partial: Partial<VisualSurfaceContext>,
): void {
  let changed = false;
  if (partial.section !== undefined && ctx.section !== partial.section) {
    ctx = { ...ctx, section: partial.section };
    changed = true;
  }
  if (partial.libBrowse !== undefined && ctx.libBrowse !== partial.libBrowse) {
    ctx = { ...ctx, libBrowse: partial.libBrowse };
    changed = true;
  }
  if (partial.studioPane !== undefined && ctx.studioPane !== partial.studioPane) {
    ctx = { ...ctx, studioPane: partial.studioPane };
    changed = true;
  }
  if (changed) {
    for (const fn of listeners) fn();
  }
}

export function subscribeVisualSurfaceActive(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Nebula dashboard/library: ferma il loop se la tab attiva non mostra il canvas. */
export function shouldPauseNebulaCanvas(surface: NebulaSurface): boolean {
  if (surface === "dashboard") return ctx.section !== "dashboard";
  return ctx.section !== "libreria" || ctx.libBrowse !== "nebula";
}

/** Visualizer/DiscoWall Ascolta: ferma se Studio non è sul pannello Listen. */
export function shouldPauseListenStageVisualizers(): boolean {
  return ctx.section !== "studio" || ctx.studioPane !== "listen";
}
