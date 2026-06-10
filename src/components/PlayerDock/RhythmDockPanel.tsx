import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayer } from "../../context/PlayerContext";
import { useRhythmMode } from "../../context/RhythmModeContext";
import { useUserState } from "../../context/UserStateContext";
import { usePlayerProgressTime } from "../../hooks/usePlayerProgressTime";
import { useI18n } from "../../i18n/useI18n";
import { resolveKaraokeLines } from "../../lib/karaokeLyrics";
import { GameCanvas } from "../../game/components/GameCanvas";
import { DIFFICULTIES } from "../../game/config/gameConfig";
import { useRhythmChart } from "../../game/hooks/useRhythmChart";
import { prefetchRhythmChart } from "../../game/lib/analyzeLibraryTrack";
import {
  loadPlectrPlayMode,
  savePlectrPlayMode,
  type PlectrPlayMode,
} from "../../game/lib/plectrDifficultyStorage";
import {
  getSessionTrackBest,
  hydrateSessionTrackBest,
  saveSessionTrackBest,
} from "../../game/lib/sessionScores";
import {
  isBetterPlectrScore,
  persistPlectrBest,
  pickBetterPlectrScore,
  plectrBestFromUserState,
} from "../../game/lib/plectrStorage";
import type { Chart, DifficultyId, GameResult } from "../../game/types";
import { audioElementMatchesTrack } from "../../lib/mediaTrackMatch";
import type { EnrichedTrack, LibraryEntityDelta, PlectrBestScore } from "../../types";
import { UiClose, UiEmojiEvents, UiPlectrum } from "../RekordUiIcons";

function makePlaceholderChart(
  track: EnrichedTrack,
  difficultyId: DifficultyId
): Chart {
  const difficulty =
    DIFFICULTIES.find((d) => d.id === difficultyId) ?? DIFFICULTIES[1];
  // Durata reale del brano quando nota, così la fine run stimata non si
  // discosta dalla traccia mentre l'analisi è in corso.
  const durationMs = track.meta?.durationMs;
  const durationSec =
    durationMs != null && Number.isFinite(durationMs)
      ? Math.max(1, Math.round(durationMs / 1000))
      : 180;
  return {
    songId: `placeholder:${track.relPath}:${difficultyId}`,
    baseSongId: track.relPath,
    difficulty,
    title: track.title || track.relPath,
    duration: durationSec,
    notes: [],
    stats: { bpm: 0, rmsAvg: 0, density: 0 },
  };
}

function resolveDisplayBest(
  relPath: string,
  plectrBests: Record<string, PlectrBestScore> | undefined
): GameResult | null {
  return pickBetterPlectrScore(
    getSessionTrackBest(relPath),
    plectrBestFromUserState(plectrBests, relPath)
  );
}

interface RhythmDockPanelProps {
  track: EnrichedTrack;
  onLibraryDelta?: (delta: LibraryEntityDelta, reconcile?: boolean) => void;
}

export const RhythmDockPanel = memo(function RhythmDockPanel({
  track,
  onLibraryDelta,
}: RhythmDockPanelProps) {
  const { t } = useI18n();
  const p = usePlayer();
  const progressTime = usePlayerProgressTime();
  const user = useUserState();
  const { setOpen } = useRhythmMode();
  const { phase, chartSet, chartRelPath, loadMessage, errorCode } =
    useRhythmChart(track);

  useLayoutEffect(() => {
    if (phase !== "ready" || p.queue.length < 2) return;
    const idx = p.currentIndex;
    if (idx < 0 || idx >= p.queue.length) return;
    const nextIdx = (idx + 1) % p.queue.length;
    const next = p.queue[nextIdx];
    if (next && next.relPath !== track.relPath) {
      prefetchRhythmChart(next);
    }
  }, [phase, p.currentIndex, p.queue, track.relPath]);

  const [playMode, setPlayMode] = useState<PlectrPlayMode>(loadPlectrPlayMode);
  const [runId, setRunId] = useState(0);
  const [lastResult, setLastResult] = useState<GameResult | null>(null);
  const [bestRevision, setBestRevision] = useState(0);
  const resumePlaybackOnCloseRef = useRef(false);
  const lastRunRef = useRef<GameResult | null>(null);
  const prevTrackRelRef = useRef(track.relPath);

  const displayBest = useMemo(
    () => resolveDisplayBest(track.relPath, user.state.plectrBests),
    [track.relPath, user.state.plectrBests, bestRevision]
  );

  const chart = useMemo((): Chart | null => {
    if (!chartSet || chartRelPath !== track.relPath) return null;
    return chartSet.charts[playMode] ?? null;
  }, [chartRelPath, chartSet, playMode, track.relPath]);

  const lastChartRef = useRef<{ relPath: string; chart: Chart } | null>(null);
  useLayoutEffect(() => {
    if (chart) lastChartRef.current = { relPath: track.relPath, chart };
  }, [chart, track.relPath]);

  const placeholderChart = useMemo(
    () => makePlaceholderChart(track, playMode),
    [playMode, track]
  );

  const displayChart = useMemo((): Chart => {
    if (chart) return chart;
    if (lastChartRef.current?.relPath === track.relPath) {
      return lastChartRef.current.chart;
    }
    return placeholderChart;
  }, [chart, placeholderChart, track.relPath]);

  useLayoutEffect(() => {
    resumePlaybackOnCloseRef.current = p.isPlaying;
  }, [p.isPlaying]);

  const persistRunScore = useCallback(
    async (
      relPath: string,
      result: GameResult,
      opts?: { showLast?: boolean; awaitPersist?: boolean }
    ) => {
      if (result.score <= 0 && result.hits <= 0) return;
      lastRunRef.current = result;
      const accountBest = plectrBestFromUserState(user.state.plectrBests, relPath);
      saveSessionTrackBest(relPath, result);
      if (opts?.showLast && relPath === track.relPath) setLastResult(result);
      if (!isBetterPlectrScore(result, accountBest)) return;
      user.savePlectrBest(relPath, result);
      const persist = async () => {
        try {
          const { delta } = await persistPlectrBest(relPath, result, accountBest);
          if (delta && onLibraryDelta) onLibraryDelta(delta, false);
          if (opts?.awaitPersist) {
            user.flushUserStateNow({ silent: true });
          }
        } catch (err: unknown) {
          console.warn(
            "[plectr] persist failed:",
            err instanceof Error ? err.message : String(err)
          );
        }
      };
      if (opts?.awaitPersist) {
        await persist();
        return;
      }
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => {
          void persist();
        }, { timeout: 2500 });
      } else {
        window.setTimeout(() => {
          void persist();
        }, 0);
      }
    },
    [onLibraryDelta, track.relPath, user]
  );

  const flushPendingRun = useCallback(
    async (relPath: string) => {
      const pending = lastRunRef.current;
      if (!pending) return;
      await persistRunScore(relPath, pending, { awaitPersist: true });
      lastRunRef.current = null;
    },
    [persistRunScore]
  );

  useLayoutEffect(() => {
    const prevRel = prevTrackRelRef.current;
    if (prevRel !== track.relPath) {
      void flushPendingRun(prevRel);
      prevTrackRelRef.current = track.relPath;
      setLastResult(null);
      lastRunRef.current = null;
    }
    hydrateSessionTrackBest(track.relPath, user.state.plectrBests);
    setBestRevision((n) => n + 1);
  }, [track.relPath, user.state.plectrBests, flushPendingRun]);

  const trackRelRef = useRef(track.relPath);
  const playerBridgeRef = useRef({
    audioRef: p.audioRef,
    seek: p.seek,
    play: p.play,
    pause: p.pause,
    isPlaying: p.isPlaying,
  });
  useLayoutEffect(() => {
    trackRelRef.current = track.relPath;
    playerBridgeRef.current = {
      audioRef: p.audioRef,
      seek: p.seek,
      play: p.play,
      pause: p.pause,
      isPlaying: p.isPlaying,
    };
  });

  const playerSync = useMemo(
    () => ({
      getCurrentTime: () => {
        const audio = playerBridgeRef.current.audioRef.current;
        if (!audio || !audioElementMatchesTrack(audio, trackRelRef.current)) {
          return 0;
        }
        return audio.currentTime;
      },
      getAudio: () => {
        const audio = playerBridgeRef.current.audioRef.current;
        if (!audio || !audioElementMatchesTrack(audio, trackRelRef.current)) {
          return null;
        }
        return audio;
      },
      seek: (seconds: number) => {
        playerBridgeRef.current.seek(seconds);
      },
      play: async () => {
        playerBridgeRef.current.play();
      },
      pause: () => {
        if (playerBridgeRef.current.isPlaying) {
          playerBridgeRef.current.pause();
        }
      },
    }),
    [],
  );

  const gameLabels = useMemo(
    () => ({
      score: t("rhythm.hudScore"),
      combo: t("rhythm.hudCombo"),
      start: t("rhythm.start"),
      pause: "",
      resume: "",
      timeAria: t("rhythm.timeAria"),
    }),
    [t]
  );

  const vizBackdrop = useMemo(() => {
    if (user.state.settings.plectrDisableVizBackdrop) return undefined;
    const mode = user.state.settings.vizMode;
    const karaoke =
      mode === "karaoke"
        ? resolveKaraokeLines(
            String(track.meta?.lyrics || "").trim(),
            progressTime,
            p.duration,
            track.title || track.relPath,
          )
        : undefined;
    return {
      mode,
      getAnalyser: p.getAnalyser,
      isPlaying: p.isPlaying,
      seedKey: track.relPath,
      karaoke,
    };
  }, [
    p.duration,
    p.getAnalyser,
    p.isPlaying,
    progressTime,
    track.meta?.lyrics,
    track.relPath,
    track.title,
    user.state.settings.plectrDisableVizBackdrop,
    user.state.settings.vizMode,
  ]);

  const loadLabel = useMemo(() => {
    if (loadMessage === "fetch") return t("rhythm.analyzingFetch");
    if (loadMessage === "decode") return t("rhythm.analyzingDecode");
    return t("rhythm.analyzingChart");
  }, [loadMessage, t]);

  const onPlayMode = useCallback((id: PlectrPlayMode) => {
    setPlayMode(id);
    savePlectrPlayMode(id);
    setLastResult(null);
    setRunId((n) => n + 1);
  }, []);

  const syncRunScore = useCallback(
    (result: GameResult) => {
      if (result.score <= 0 && result.hits <= 0) return;
      lastRunRef.current = result;
      saveSessionTrackBest(track.relPath, result);
      setBestRevision((n) => n + 1);
    },
    [track.relPath]
  );

  const onRunUpdate = useCallback(
    (result: GameResult) => {
      syncRunScore(result);
    },
    [syncRunScore]
  );

  const onFinish = useCallback(
    (result: GameResult) => {
      void persistRunScore(track.relPath, result, {
        showLast: true,
        awaitPersist: true,
      });
    },
    [persistRunScore, track.relPath]
  );

  const onReplay = useCallback(() => {
    setLastResult(null);
    setRunId((n) => n + 1);
  }, []);

  const flushPendingRunRef = useRef(flushPendingRun);
  const flushUserStateNowRef = useRef(user.flushUserStateNow);
  flushPendingRunRef.current = flushPendingRun;
  flushUserStateNowRef.current = user.flushUserStateNow;

  const onClose = useCallback(() => {
    void flushPendingRun(track.relPath);
    user.flushUserStateNow({ silent: true });
    setOpen(false);
    if (resumePlaybackOnCloseRef.current && !p.isPlaying) {
      p.play();
    }
  }, [flushPendingRun, p, setOpen, track.relPath, user]);

  useLayoutEffect(() => {
    return () => {
      flushPendingRunRef.current(prevTrackRelRef.current);
      flushUserStateNowRef.current({ silent: true });
    };
  }, []);

  return (
    <section
      className="rhythm-dock-panel"
      aria-label={t("plectr.title")}
    >
      <header className="rhythm-dock-panel__head">
        <div className="rhythm-dock-panel__head-top">
          <div className="rhythm-dock-panel__brand">
            <UiPlectrum className="rhythm-dock-panel__brand-ic" aria-hidden />
            <span>{t("plectr.title")}</span>
          </div>
          <p className="rhythm-dock-panel__record" aria-live="polite">
            {lastResult ? (
              <>
                <span className="rhythm-dock-panel__record-label">
                  {t("rhythm.lastRun")}
                </span>
                <strong>
                  {lastResult.score.toLocaleString()}
                  {lastResult.grade ? ` · ${lastResult.grade}` : ""}
                </strong>
              </>
            ) : displayBest ? (
              <>
                <span
                  className="rhythm-dock-panel__record-label rhythm-dock-panel__record-label--trophy"
                  aria-label={t("rhythm.statBest")}
                >
                  <UiEmojiEvents
                    className="rhythm-dock-panel__trophy-ic"
                    aria-hidden
                  />
                </span>
                <strong>
                  {displayBest.score.toLocaleString()}
                  {displayBest.grade ? ` · ${displayBest.grade}` : ""}
                </strong>
              </>
            ) : (
              <>
                <span
                  className="rhythm-dock-panel__record-label rhythm-dock-panel__record-label--trophy"
                  aria-label={t("rhythm.statBest")}
                >
                  <UiEmojiEvents
                    className="rhythm-dock-panel__trophy-ic"
                    aria-hidden
                  />
                </span>
                <span className="rhythm-dock-panel__record-empty">—</span>
              </>
            )}
          </p>
          <div className="rhythm-dock-panel__head-actions">
            {lastResult ? (
              <button
                type="button"
                className="rhythm-dock-panel__replay"
                onClick={onReplay}
              >
                {t("rhythm.replay")}
              </button>
            ) : null}
            <button
              type="button"
              className="rhythm-dock-panel__close"
              onClick={onClose}
              aria-label={t("rhythm.exit")}
            >
              <UiClose className="rhythm-dock-panel__close-ic" />
            </button>
          </div>
        </div>

        <div
          className="rhythm-dock-panel__diffs"
          role="group"
          aria-label={t("rhythm.difficulty")}
        >
          {DIFFICULTIES.map((d) => {
            const count = chartSet?.charts[d.id]?.notes.length ?? 0;
            const disabled = count < 12;
            return (
              <button
                key={d.id}
                type="button"
                className={`rhythm-dock-panel__diff${
                  playMode === d.id ? " is-active" : ""
                }`}
                disabled={disabled || phase !== "ready"}
                aria-pressed={playMode === d.id}
                onClick={() => onPlayMode(d.id)}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="rhythm-dock-panel__body">
        {phase === "error" ? (
          <div className="rhythm-dock-panel__status rhythm-dock-panel__status--error">
            <p>
              {errorCode
                ? t(`rhythm.errors.${errorCode}`)
                : t("rhythm.errors.decode")}
            </p>
          </div>
        ) : null}

        {phase !== "error" ? (
          <div className="rhythm-dock-panel__canvas-wrap">
            {phase === "loading" && !chart ? (
              <div
                className="rhythm-dock-panel__status rhythm-dock-panel__status--overlay"
                aria-live="polite"
              >
                <p>{loadLabel}</p>
                <p className="rhythm-dock-panel__status-sub">
                  {t("rhythm.analyzingKeepPlaying")}
                </p>
              </div>
            ) : null}
            <GameCanvas
              key={playMode}
              chart={displayChart}
              runId={runId}
              embedded
              syncLive
              playerSync={playerSync}
              vizBackdrop={vizBackdrop}
              onFinish={onFinish}
              onRunUpdate={onRunUpdate}
              labels={gameLabels}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
});
