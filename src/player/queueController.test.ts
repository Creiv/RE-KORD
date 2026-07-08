import { describe, expect, it } from "vitest";
import {
  capQueueAroundFocus,
  computeIndexAfterMove,
  computeIndexAfterRemove,
  cycleRepeatMode,
  planPlayTrackQueue,
  queueRelPathSignature,
  reorder,
  restoreQueueFromShufflePaths,
  shuffleTailFromCurrent,
} from "./queueController";
import type { EnrichedTrack } from "../types";

function track(relPath: string): EnrichedTrack {
  return {
    id: relPath,
    relPath,
    title: relPath,
    artist: "A",
    album: "B",
    updatedAt: 1,
  };
}

describe("queueController", () => {
  it("capQueueAroundFocus keeps small queues intact", () => {
    const items = [1, 2, 3];
    expect(capQueueAroundFocus(items, 1)).toEqual({ items, index: 1 });
  });

  it("capQueueAroundFocus centers a long queue on focus", () => {
    const items = Array.from({ length: 600 }, (_, i) => i);
    const { items: capped, index } = capQueueAroundFocus(items, 300);
    expect(capped).toHaveLength(500);
    expect(capped[index]).toBe(300);
  });

  it("reorder moves an item", () => {
    expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("shuffleTailFromCurrent preserves prefix", () => {
    const items = ["a", "b", "c", "d", "e"];
    const shuffled = shuffleTailFromCurrent(items, 1);
    expect(shuffled.slice(0, 2)).toEqual(["a", "b"]);
    expect(shuffled).toHaveLength(5);
    expect(new Set(shuffled)).toEqual(new Set(items));
  });

  it("queueRelPathSignature joins rel paths", () => {
    const q = [track("a.mp3"), track("b.mp3")];
    expect(queueRelPathSignature(q)).toBe("a.mp3\0b.mp3");
  });

  it("computeIndexAfterRemove adjusts active index", () => {
    expect(computeIndexAfterRemove(0, 2)).toBe(1);
    expect(computeIndexAfterRemove(2, 2)).toBe("current_removed");
    expect(computeIndexAfterRemove(3, 1)).toBe("unchanged");
  });

  it("computeIndexAfterMove updates active index", () => {
    expect(computeIndexAfterMove(0, 2, 0)).toBe(2);
    expect(computeIndexAfterMove(0, 2, 1)).toBe(0);
    expect(computeIndexAfterMove(3, 1, 2)).toBe(3);
  });

  it("restoreQueueFromShufflePaths restores original order", () => {
    const q = [track("c.mp3"), track("a.mp3"), track("b.mp3")];
    const paths = ["a.mp3", "b.mp3", "c.mp3"];
    const { items, index } = restoreQueueFromShufflePaths(q, paths, "b.mp3");
    expect(items.map((t) => t.relPath)).toEqual(paths);
    expect(items[index]?.relPath).toBe("b.mp3");
  });

  it("cycleRepeatMode cycles off → all → one → off", () => {
    expect(cycleRepeatMode("off")).toBe("all");
    expect(cycleRepeatMode("all")).toBe("one");
    expect(cycleRepeatMode("one")).toBe("off");
  });

  it("planPlayTrackQueue detects queue replacement", () => {
    const t = track("x.mp3");
    const plan = planPlayTrackQueue(t, [t, track("y.mp3")], 0, false, []);
    expect(plan.queueReplaced).toBe(true);
    expect(plan.shouldShuffle).toBe(false);
    expect(plan.nextQueue).toHaveLength(2);
  });

  it("planPlayTrackQueue shuffles when enabled on new queue", () => {
    const tracks = [track("a.mp3"), track("b.mp3"), track("c.mp3")];
    const plan = planPlayTrackQueue(tracks[0], tracks, 0, true, []);
    expect(plan.shouldShuffle).toBe(true);
    expect(plan.shuffledQueue).not.toBeNull();
    expect(plan.shuffledQueue?.[0]?.relPath).toBe("a.mp3");
  });
});
