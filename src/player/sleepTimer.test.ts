import { describe, expect, it } from "vitest";
import {
  SLEEP_FADE_MS,
  computeSleepFadeDelay,
  computeSleepFadeGain,
} from "./sleepTimer";

describe("sleepTimer", () => {
  it("computeSleepFadeGain fades linearly to zero", () => {
    expect(computeSleepFadeGain(0)).toBe(1);
    expect(computeSleepFadeGain(SLEEP_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(computeSleepFadeGain(SLEEP_FADE_MS)).toBe(0);
    expect(computeSleepFadeGain(SLEEP_FADE_MS + 1000)).toBe(0);
  });

  it("computeSleepFadeDelay starts fade before timer ends", () => {
    const endsAt = 1_000_000;
    const now = endsAt - SLEEP_FADE_MS - 5_000;
    expect(computeSleepFadeDelay(endsAt, now)).toBe(5_000);
  });

  it("computeSleepFadeDelay is zero when fade should start immediately", () => {
    const endsAt = 1_000_000;
    const now = endsAt - SLEEP_FADE_MS;
    expect(computeSleepFadeDelay(endsAt, now)).toBe(0);
  });
});
