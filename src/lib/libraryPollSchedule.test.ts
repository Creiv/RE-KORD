import { describe, expect, it } from "vitest";
import {
  libraryPollDelayMs,
  shouldSkipLibraryPoll,
} from "./libraryPollSchedule";

describe("libraryPollSchedule", () => {
  it("salta poll in background", () => {
    expect(shouldSkipLibraryPoll(false)).toBe(true);
    expect(shouldSkipLibraryPoll(true)).toBe(false);
  });

  it("backoff su fallimenti consecutivi", () => {
    const base = libraryPollDelayMs({
      foreground: true,
      consecutiveUnchanged: 0,
      consecutiveFailures: 0,
    });
    const afterFail = libraryPollDelayMs({
      foreground: true,
      consecutiveUnchanged: 0,
      consecutiveFailures: 2,
    });
    expect(afterFail).toBeGreaterThan(base);
  });

  it("rallenta dopo poll senza cambiamenti", () => {
    const base = libraryPollDelayMs({
      foreground: true,
      consecutiveUnchanged: 0,
      consecutiveFailures: 0,
    });
    const stale = libraryPollDelayMs({
      foreground: true,
      consecutiveUnchanged: 6,
      consecutiveFailures: 0,
    });
    expect(stale).toBeGreaterThan(base);
  });

  it("background usa intervallo lento", () => {
    expect(
      libraryPollDelayMs({
        foreground: false,
        consecutiveUnchanged: 0,
        consecutiveFailures: 0,
      }),
    ).toBe(30_000);
  });
});
