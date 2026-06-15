import { describe, expect, it } from "vitest";
import {
  createSongClockState,
  resetSongClock,
  resolveSmoothSongTime,
  type PlayerSyncBridgeLike,
} from "./smoothSongClock";

function makeBridge(reportedTime: number, playing = true): PlayerSyncBridgeLike {
  const audio = playing
    ? ({
        currentTime: reportedTime,
        paused: false,
        ended: false,
        playbackRate: 1,
      } as HTMLAudioElement)
    : null;
  return {
    getCurrentTime: () => reportedTime,
    getAudio: () => audio,
  };
}

describe("resolveSmoothSongTime", () => {
  it("avanza in modo fluido quando audio.currentTime resta fermo tra i campioni", () => {
    const clock = createSongClockState();
    let reported = 10;
    const bridge = makeBridge(reported);
    resetSongClock(clock, 10, 1000);
    clock.audioSampleSong = 10;
    clock.audioSamplePerf = 1000;
    clock.audioPlaybackRate = 1;

    let songTime = 10;
    for (let perf = 1016; perf <= 5000; perf += 16) {
      songTime = resolveSmoothSongTime(clock, perf, bridge);
    }

    expect(songTime).toBeGreaterThan(13.5);
    expect(songTime).toBeLessThan(14.2);

    reported = 14;
    songTime = resolveSmoothSongTime(clock, 5016, makeBridge(reported));
    expect(songTime).toBeGreaterThan(13.8);
    expect(songTime).toBeLessThan(14.3);
  });

  it("si ferma quando il player è in pausa", () => {
    const clock = createSongClockState();
    const bridge = makeBridge(42, false);
    const songTime = resolveSmoothSongTime(clock, 2000, bridge);
    expect(songTime).toBe(42);
    expect(clock.clockAnchorSong).toBe(42);
  });
});
