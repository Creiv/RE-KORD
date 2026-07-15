import { libraryPollIntervalMs } from "./renderQuality";

export type LibraryPollBackoffInput = {
  foreground: boolean;
  consecutiveUnchanged: number;
  consecutiveFailures: number;
  isPlaying?: boolean;
};

/** Intervallo adattivo tra due poll libreria (ms). */
export function libraryPollDelayMs(input: LibraryPollBackoffInput): number {
  if (!input.foreground) {
    return libraryPollIntervalMs(true, input.isPlaying ?? false);
  }
  const base = libraryPollIntervalMs(false, input.isPlaying ?? false);
  if (input.consecutiveFailures > 0) {
    return Math.min(
      120_000,
      Math.round(base * Math.pow(2, Math.min(input.consecutiveFailures, 4))),
    );
  }
  if (input.consecutiveUnchanged >= 5) {
    return Math.min(
      90_000,
      Math.round(base * (1 + (input.consecutiveUnchanged - 4) * 0.75)),
    );
  }
  if (input.consecutiveUnchanged >= 2) {
    return Math.min(60_000, Math.round(base * 1.5));
  }
  return base;
}

/** Nessun poll mentre l'app è in background. */
export function shouldSkipLibraryPoll(foreground: boolean): boolean {
  return !foreground;
}
