import type { RepeatMode } from "../types";

/** Indice del prossimo brano, o null se la riproduzione deve fermarsi. */
export function resolveNextIndex(
  len: number,
  cur: number,
  repeat: RepeatMode,
  hasRemainder: boolean,
): number | null {
  if (len <= 0) return null;
  if (repeat === "one") return cur;
  if (cur < len - 1) return cur + 1;
  if (hasRemainder) return len;
  if (repeat === "all") return 0;
  return null;
}

/** Indice del brano precedente, o null se non disponibile. */
export function resolvePrevIndex(
  len: number,
  cur: number,
  repeat: RepeatMode,
): number | null {
  if (len <= 0) return null;
  if (cur > 0) return cur - 1;
  if (repeat === "all") return len - 1;
  return null;
}

export function mediaSessionHasNext(
  qIndex: number,
  queueLen: number,
  repeat: RepeatMode,
  hasRemainder: boolean,
): boolean {
  if (queueLen <= 0) return false;
  return (
    qIndex < queueLen - 1 ||
    hasRemainder ||
    (repeat === "all" && queueLen > 0)
  );
}

export function mediaSessionHasPrevious(
  qIndex: number,
  queueLen: number,
  repeat: RepeatMode,
): boolean {
  if (queueLen <= 0) return false;
  return qIndex > 0 || (repeat === "all" && queueLen > 0);
}
