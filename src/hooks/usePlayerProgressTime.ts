import { useSyncExternalStore } from "react";
import {
  getPlayerProgressSnapshot,
  readPlayerProgressTime,
  subscribePlayerProgress,
} from "../context/playerProgressStore";

/** Tempo di riproduzione per UI (barra, LRC). Non invalida tutto il PlayerContext. */
export function usePlayerProgressTime(): number {
  useSyncExternalStore(
    subscribePlayerProgress,
    getPlayerProgressSnapshot,
    getPlayerProgressSnapshot,
  );
  return readPlayerProgressTime();
}
