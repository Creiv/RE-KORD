import { describe, expect, it } from "vitest";
import { sanitizeChartForKord } from "./chartSanitize";
import type { Chart } from "../types";

function chartWithHold(): Chart {
  return {
    songId: "song:easy",
    baseSongId: "song",
    difficulty: {
      id: "easy",
      label: "Easy",
      tag: "4B",
      level: 7,
      onsetAdjust: 0,
      cooldownBase: 0.4,
      cooldownDrop: 0.2,
      cooldownMin: 0.2,
      pulseModulo: 8,
      holdEvery: 3,
      holdIntensity: 0.3,
      swipeEvery: 0,
      swipeIntensity: 1,
    },
    title: "Song",
    duration: 30,
    notes: [
      {
        id: 0,
        type: "tap",
        direction: null,
        time: 4,
        lane: 1,
        endLane: 1,
        duration: 0.8,
        hit: true,
        missed: true,
        holding: true,
        completed: true,
      },
      {
        id: 1,
        type: "swipe",
        direction: "up",
        time: 5,
        lane: 2,
        endLane: null,
        duration: 0,
        hit: false,
        missed: false,
        holding: false,
        completed: false,
      },
    ],
    stats: { bpm: 120, rmsAvg: 0.1, density: 1 },
  };
}

describe("sanitizeChartForKord", () => {
  it("keeps maintained notes on every difficulty and removes swipes", () => {
    const sanitized = sanitizeChartForKord(chartWithHold());

    expect(sanitized.notes).toHaveLength(1);
    expect(sanitized.notes[0]).toMatchObject({
      id: 0,
      type: "hold",
      direction: null,
      duration: 0.8,
      hit: false,
      missed: false,
      holding: false,
      completed: false,
    });
  });
});
