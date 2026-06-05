import { useSyncExternalStore } from "react";
import { MOBILE_LAYOUT_MQ } from "../lib/breakpoints";

let open = false;
const listeners = new Set<() => void>();

export function subscribeRhythmModeOpen(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function getRhythmModeOpenSnapshot(): boolean {
  return open;
}

export function setRhythmModeOpenSnapshot(next: boolean): void {
  if (open === next) return;
  open = next;
  if (typeof document !== "undefined") {
    if (next) {
      document.documentElement.dataset.rekordPlectr = "1";
    } else {
      delete document.documentElement.dataset.rekordPlectr;
    }
  }
  for (const fn of listeners) fn();
}

/** Lettura senza re-render del consumer (es. loop canvas / visualizer). */
export function isRhythmModeOpen(): boolean {
  return open;
}

/** Su mobile Plectr ferma i visualizer di sfondo; su desktop restano attivi. */
export function shouldPauseBackgroundVisualizersForPlectr(): boolean {
  if (!open) return false;
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_LAYOUT_MQ).matches;
}

/** Per componenti che devono aggiornarsi all'apertura/chiusura Plectr. */
export function useRhythmModeOpen(): boolean {
  return useSyncExternalStore(
    subscribeRhythmModeOpen,
    getRhythmModeOpenSnapshot,
    () => false,
  );
}
