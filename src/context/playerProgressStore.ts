/** Store leggero per la UI di avanzamento — evita setState globale a ogni timeupdate. */

export type PlayerProgressSnapshot = {
  time: number;
  version: number;
};

let snapshot: PlayerProgressSnapshot = { time: 0, version: 0 };
const listeners = new Set<() => void>();

export function getPlayerProgressSnapshot(): number {
  return snapshot.version;
}

export function readPlayerProgressTime(): number {
  return snapshot.time;
}

export function subscribePlayerProgress(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function setPlayerProgressTime(time: number, force = false): void {
  const t = Number.isFinite(time) ? time : 0;
  if (!force && Math.abs(t - snapshot.time) < 0.04) return;
  snapshot = { time: t, version: snapshot.version + 1 };
  for (const fn of listeners) fn();
}

export function resetPlayerProgressTime(): void {
  snapshot = { time: 0, version: snapshot.version + 1 };
  for (const fn of listeners) fn();
}
