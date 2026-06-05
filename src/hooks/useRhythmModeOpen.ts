import { useSyncExternalStore } from "react";

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

/** Con Plectr aperto il visualizer di Ascolta resta fermo (sfondo nel canvas Plectr). */
export function shouldPauseBackgroundVisualizersForPlectr(): boolean {
  return open;
}

/** Per componenti che devono aggiornarsi all'apertura/chiusura Plectr. */
export function useRhythmModeOpen(): boolean {
  return useSyncExternalStore(
    subscribeRhythmModeOpen,
    getRhythmModeOpenSnapshot,
    () => false,
  );
}
