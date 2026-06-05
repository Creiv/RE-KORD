export type PlayerSyncBridgeLike = {
  getCurrentTime: () => number;
  getAudio: () => HTMLAudioElement | null;
};

/** Seek / drift grande: riallinea subito al player. */
const CLOCK_HARD_SYNC_THRESHOLD_SECONDS = 0.45;
/** Costante tempo per inseguire audio.currentTime senza scatti a intervalli fissi. */
const CLOCK_SMOOTH_TAU_SECONDS = 0.14;
/** Sotto questa soglia l’extrapolazione performance.now basta (niente micro-correzioni). */
const CLOCK_MIN_CORRECTION_SECONDS = 0.0025;

export type SongClockState = {
  clockAnchorSong: number;
  clockAnchorPerf: number;
  smoothFramePerf: number;
};

export function createSongClockState(): SongClockState {
  return {
    clockAnchorSong: 0,
    clockAnchorPerf: 0,
    smoothFramePerf: 0,
  };
}

export function resetSongClock(
  clock: SongClockState,
  songTime: number,
  perfNow: number,
): void {
  clock.clockAnchorSong = songTime;
  clock.clockAnchorPerf = perfNow;
  clock.smoothFramePerf = perfNow;
}

function readAudioReferenceTime(bridge: PlayerSyncBridgeLike): number {
  const audio = bridge.getAudio();
  if (audio && Number.isFinite(audio.currentTime)) {
    return audio.currentTime;
  }
  return bridge.getCurrentTime();
}

/** Orologio fluido per il rendering delle note in sync col player globale. */
export function resolveSmoothSongTime(
  clock: SongClockState,
  perfNow: number,
  bridge: PlayerSyncBridgeLike,
): number {
  const audio = bridge.getAudio();
  const audioT = readAudioReferenceTime(bridge);
  const playing = Boolean(audio && !audio.paused && !audio.ended);
  const playbackRate =
    audio?.playbackRate && Number.isFinite(audio.playbackRate)
      ? audio.playbackRate
      : 1;

  if (!playing) {
    resetSongClock(clock, audioT, perfNow);
    return audioT;
  }

  if (clock.clockAnchorPerf <= 0) {
    resetSongClock(clock, audioT, perfNow);
    return audioT;
  }

  const prevPerf =
    clock.smoothFramePerf > 0 ? clock.smoothFramePerf : perfNow;
  const dtSec = Math.min(0.05, Math.max(0, (perfNow - prevPerf) / 1000));
  clock.smoothFramePerf = perfNow;

  const t =
    clock.clockAnchorSong +
    ((perfNow - clock.clockAnchorPerf) / 1000) * playbackRate;
  const err = audioT - t;

  if (Math.abs(err) > CLOCK_HARD_SYNC_THRESHOLD_SECONDS) {
    resetSongClock(clock, audioT, perfNow);
    return audioT;
  }

  if (Math.abs(err) <= CLOCK_MIN_CORRECTION_SECONDS) {
    return t;
  }

  const blend = 1 - Math.exp(-dtSec / CLOCK_SMOOTH_TAU_SECONDS);
  const corrected = t + err * blend;
  resetSongClock(clock, corrected, perfNow);
  return corrected;
}
