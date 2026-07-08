import type { RefObject } from "react";

export const SLEEP_FADE_MS = 30_000;
export const SLEEP_FADE_INTERVAL_MS = 180;

export type SleepTimerController = {
  clear: () => void;
  set: (minutes: number | null) => void;
};

export function createSleepTimerController(deps: {
  sleepTimerTimeoutRef: RefObject<number>;
  sleepFadeIntervalRef: RefObject<number>;
  outputGainRef: RefObject<GainNode | null>;
  setSleepTimerEndsAt: (v: number | null) => void;
  pause: () => void;
}): SleepTimerController {
  const clear = () => {
    if (deps.sleepTimerTimeoutRef.current) {
      window.clearTimeout(deps.sleepTimerTimeoutRef.current);
      deps.sleepTimerTimeoutRef.current = 0;
    }
    if (deps.sleepFadeIntervalRef.current) {
      window.clearInterval(deps.sleepFadeIntervalRef.current);
      window.clearTimeout(deps.sleepFadeIntervalRef.current);
      deps.sleepFadeIntervalRef.current = 0;
    }
    const out = deps.outputGainRef.current;
    if (out) out.gain.value = 1;
    deps.setSleepTimerEndsAt(null);
  };

  const set = (minutes: number | null) => {
    clear();
    if (minutes == null || minutes <= 0) return;
    const endsAt = Date.now() + minutes * 60_000;
    deps.setSleepTimerEndsAt(endsAt);
    const delay = Math.max(0, endsAt - Date.now() - SLEEP_FADE_MS);
    deps.sleepTimerTimeoutRef.current = window.setTimeout(() => {
      const out = deps.outputGainRef.current;
      const fadeStart = Date.now();
      deps.sleepFadeIntervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - fadeStart;
        const ratio = Math.max(0, 1 - elapsed / SLEEP_FADE_MS);
        if (out) out.gain.value = ratio;
        if (elapsed >= SLEEP_FADE_MS) {
          clear();
          deps.pause();
        }
      }, SLEEP_FADE_INTERVAL_MS);
    }, delay);
  };

  return { clear, set };
}

export function computeSleepFadeGain(elapsedMs: number): number {
  return Math.max(0, 1 - elapsedMs / SLEEP_FADE_MS);
}

export function computeSleepFadeDelay(endsAt: number, now: number): number {
  return Math.max(0, endsAt - now - SLEEP_FADE_MS);
}
