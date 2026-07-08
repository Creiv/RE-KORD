import { resolveNextIndex } from "../lib/playerQueueAdvance";
import { fisherYatesShuffle } from "../lib/smartShuffle";
import type { EnrichedTrack, RepeatMode } from "../types";
import { MAX_QUEUE_LENGTH } from "./types";

export function capQueueAroundFocus<T>(items: T[], focusIndex: number) {
  if (items.length <= MAX_QUEUE_LENGTH) {
    const i = items.length
      ? Math.max(0, Math.min(focusIndex, items.length - 1))
      : 0;
    return { items, index: i };
  }
  const safe = Math.max(0, Math.min(focusIndex, items.length - 1));
  let start = Math.max(0, safe - Math.floor(MAX_QUEUE_LENGTH / 2));
  if (start + MAX_QUEUE_LENGTH > items.length) {
    start = items.length - MAX_QUEUE_LENGTH;
  }
  const sliced = items.slice(start, start + MAX_QUEUE_LENGTH);
  return { items: sliced, index: safe - start };
}

export function reorder<T>(items: T[], from: number, to: number) {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export function shuffleTailFromCurrent<T>(items: T[], currentIdx: number): T[] {
  if (items.length <= 1) return items;
  const i = Math.min(Math.max(0, currentIdx), items.length - 1);
  const prefix = items.slice(0, i + 1);
  const tail = items.slice(i + 1);
  if (tail.length < 2) return [...prefix, ...tail];
  return [...prefix, ...fisherYatesShuffle(tail)];
}

export function queueRelPathSignature(queue: readonly EnrichedTrack[]): string {
  return queue.map((t) => t.relPath).join("\0");
}

export function resolveNextPlaybackIndex(
  queue: readonly EnrichedTrack[],
  baseIndex: number,
  repeat: RepeatMode,
  hasRemainder: boolean,
): number | null {
  const len = queue.length;
  const nextIdx = resolveNextIndex(len, baseIndex, repeat, hasRemainder);
  if (nextIdx == null) return null;
  if (nextIdx >= len && hasRemainder) {
    return nextIdx;
  }
  return nextIdx;
}

export function computeIndexAfterRemove(
  removedIndex: number,
  currentIndex: number,
): number | "current_removed" | "unchanged" {
  if (removedIndex < currentIndex) return currentIndex - 1;
  if (removedIndex === currentIndex) return "current_removed";
  return "unchanged";
}

export function computeIndexAfterMove(
  from: number,
  to: number,
  active: number,
): number {
  if (active === from) return to;
  if (from < active && to >= active) return active - 1;
  if (from > active && to <= active) return active + 1;
  return active;
}

export function restoreQueueFromShufflePaths(
  queue: readonly EnrichedTrack[],
  paths: readonly string[],
  currentRelPath: string | null,
): { items: EnrichedTrack[]; index: number } {
  const byPath = new Map(queue.map((t) => [t.relPath, t]));
  const seen = new Set<string>();
  const restored: EnrichedTrack[] = [];
  for (const p of paths) {
    const t = byPath.get(p);
    if (t && !seen.has(p)) {
      restored.push(t);
      seen.add(p);
    }
  }
  for (const t of queue) {
    if (!seen.has(t.relPath)) restored.push(t);
  }
  if (!restored.length) return { items: [], index: 0 };
  const newIdx = currentRelPath
    ? restored.findIndex((t) => t.relPath === currentRelPath)
    : 0;
  const j = newIdx >= 0 ? newIdx : 0;
  return capQueueAroundFocus(restored, j);
}

export function cycleRepeatMode(current: RepeatMode): RepeatMode {
  return current === "off" ? "all" : current === "all" ? "one" : "off";
}

export type PlayTrackQueuePlan = {
  nextQueue: EnrichedTrack[];
  safeIndex: number;
  queueReplaced: boolean;
  shouldShuffle: boolean;
  shuffledQueue: EnrichedTrack[] | null;
};

export function planPlayTrackQueue(
  track: EnrichedTrack,
  list: EnrichedTrack[] | undefined,
  at: number | undefined,
  shuffle: boolean,
  currentQueue: readonly EnrichedTrack[],
  opts?: { preserveQueueOrder?: boolean },
): PlayTrackQueuePlan {
  const fullQueue = list?.length ? [...list] : [track];
  const nextIndex =
    at ?? fullQueue.findIndex((item) => item.relPath === track.relPath);
  const preCapIndex = nextIndex >= 0 ? nextIndex : 0;
  const { items: nextQueue, index: safeIndex } = capQueueAroundFocus(
    fullQueue,
    preCapIndex,
  );
  const newSig = queueRelPathSignature(nextQueue);
  const oldSig = queueRelPathSignature(currentQueue);
  const queueReplaced = newSig !== oldSig;
  const shouldShuffle =
    nextQueue.length > 1 &&
    shuffle &&
    queueReplaced &&
    !opts?.preserveQueueOrder;
  const shuffledQueue = shouldShuffle
    ? shuffleTailFromCurrent(nextQueue, safeIndex)
    : null;
  return {
    nextQueue,
    safeIndex,
    queueReplaced,
    shouldShuffle,
    shuffledQueue,
  };
}
