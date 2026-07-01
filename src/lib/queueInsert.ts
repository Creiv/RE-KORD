/** Indice di inserimento per "riproduci come prossimo" nella coda. */
export function computeQueueInsertIndex(
  queue: readonly { relPath: string }[],
  options: {
    currentRelPath: string | null;
    currentIndex: number;
    crossfadeBusy: boolean;
    crossfadeNextIndex: number | null;
    manualQueuedPaths: ReadonlySet<string>;
  },
): number {
  let base: number;
  if (options.crossfadeBusy && options.crossfadeNextIndex != null) {
    base = options.crossfadeNextIndex + 1;
  } else if (options.currentRelPath) {
    const byPath = queue.findIndex(
      (track) => track.relPath === options.currentRelPath,
    );
    base = byPath >= 0 ? byPath + 1 : options.currentIndex + 1;
  } else {
    base = options.currentIndex + 1;
  }
  let at = Math.min(Math.max(0, base), queue.length);
  while (at < queue.length && options.manualQueuedPaths.has(queue[at]!.relPath)) {
    at += 1;
  }
  return at;
}

export function insertTracksInQueue<T extends { relPath: string }>(
  queue: readonly T[],
  tracks: readonly T[],
  insertAt: number,
): T[] {
  const at = Math.min(Math.max(0, insertAt), queue.length);
  return [...queue.slice(0, at), ...tracks, ...queue.slice(at)];
}
