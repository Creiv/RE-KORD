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
/** Delta minimo su audio.currentTime per considerarlo un nuovo campione dal browser. */
const AUDIO_SAMPLE_EPSILON_SECONDS = 0.0005;

export type SongClockState = {
  clockAnchorSong: number;
  clockAnchorPerf: number;
  smoothFramePerf: number;
  /** Ultimo audio.currentTime campionato dal browser. */
  audioSampleSong: number;
  audioSamplePerf: number;
  audioPlaybackRate: number;
};

export function createSongClockState(): SongClockState {
  return {
    clockAnchorSong: 0,
    clockAnchorPerf: 0,
    smoothFramePerf: 0,
    audioSampleSong: 0,
    audioSamplePerf: 0,
    audioPlaybackRate: 1,
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

/**
 * Su mobile audio.currentTime spesso resta fermo tra un timeupdate e l'altro
 * (anche diversi secondi). Confrontarlo ogni frame con l'extrapolazione da
 * performance.now fa arretrare le note fino al salto del campione successivo.
 */
function readInterpolatedAudioTime(
  clock: SongClockState,
  bridge: PlayerSyncBridgeLike,
  perfNow: number,
  playing: boolean,
  playbackRate: number,
): number {
  const audio = bridge.getAudio();
  const raw = audio && Number.isFinite(audio.currentTime)
    ? audio.currentTime
    : bridge.getCurrentTime();

  if (!playing) {
    clock.audioSampleSong = raw;
    clock.audioSamplePerf = perfNow;
    clock.audioPlaybackRate = playbackRate;
    return raw;
  }

  if (
    clock.audioSamplePerf <= 0 ||
    Math.abs(raw - clock.audioSampleSong) > AUDIO_SAMPLE_EPSILON_SECONDS
  ) {
    clock.audioSampleSong = raw;
    clock.audioSamplePerf = perfNow;
    clock.audioPlaybackRate = playbackRate;
    return raw;
  }

  return (
    clock.audioSampleSong +
    ((perfNow - clock.audioSamplePerf) / 1000) * clock.audioPlaybackRate
  );
}

/** Orologio fluido per il rendering delle note in sync col player globale. */
export function resolveSmoothSongTime(
  clock: SongClockState,
  perfNow: number,
  bridge: PlayerSyncBridgeLike,
): number {
  const audio = bridge.getAudio();
  const playing = Boolean(audio && !audio.paused && !audio.ended);
  const playbackRate =
    audio?.playbackRate && Number.isFinite(audio.playbackRate)
      ? audio.playbackRate
      : 1;
  const audioT = readInterpolatedAudioTime(
    clock,
    bridge,
    perfNow,
    playing,
    playbackRate,
  );

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
