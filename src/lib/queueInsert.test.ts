import { describe, expect, it } from "vitest";
import { computeQueueInsertIndex, insertTracksInQueue } from "./queueInsert";

describe("queueInsert", () => {
  const queue = [
    { relPath: "a.mp3" },
    { relPath: "b.mp3" },
    { relPath: "c.mp3" },
    { relPath: "d.mp3" },
  ];

  it("inserts after current track by relPath", () => {
    expect(
      computeQueueInsertIndex(queue, {
        currentRelPath: "b.mp3",
        currentIndex: 0,
        crossfadeBusy: false,
        crossfadeNextIndex: null,
        manualQueuedPaths: new Set(),
      }),
    ).toBe(2);
  });

  it("prefers relPath over stale currentIndex", () => {
    expect(
      computeQueueInsertIndex(queue, {
        currentRelPath: "c.mp3",
        currentIndex: 0,
        crossfadeBusy: false,
        crossfadeNextIndex: null,
        manualQueuedPaths: new Set(),
      }),
    ).toBe(3);
  });

  it("inserts after pending manual queue items", () => {
    expect(
      computeQueueInsertIndex(queue, {
        currentRelPath: "a.mp3",
        currentIndex: 0,
        crossfadeBusy: false,
        crossfadeNextIndex: null,
        manualQueuedPaths: new Set(["b.mp3"]),
      }),
    ).toBe(2);
  });

  it("insertTracksInQueue splices at index", () => {
    expect(
      insertTracksInQueue(queue, [{ relPath: "x.mp3" }], 1).map((t) => t.relPath),
    ).toEqual(["a.mp3", "x.mp3", "b.mp3", "c.mp3", "d.mp3"]);
  });
});
