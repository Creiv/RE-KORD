import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../context/PlayerContext";
import { usePlayerProgressTime } from "../hooks/usePlayerProgressTime";
import { useI18n } from "../i18n/useI18n";
import {
  shouldPauseBackgroundVisualizersForPlectr,
  subscribeRhythmModeOpen,
} from "../hooks/useRhythmModeOpen";
import {
  shouldPauseListenStageVisualizers,
  subscribeVisualSurfaceActive,
} from "../hooks/useVisualSurfaceActive";
import { subscribeAppForeground } from "../hooks/useAppForeground";
import { MOBILE_LAYOUT_MQ } from "../lib/breakpoints";
import { canvasDprCap, vizLoopCadence } from "../lib/renderQuality";
import { parseLrcLyrics, resolveKaraokeLines } from "../lib/karaokeLyrics";
import { VizCanvasEngine } from "../lib/vizCanvasEngine";
import type { VizMode } from "../types";

export function Visualizer({
  mode,
  fullscreenOnly = false,
  onExitFullscreen,
}: {
  mode: VizMode;
  /** Render solo come overlay fullscreen (es. karaoke da pulsante microfono). */
  fullscreenOnly?: boolean;
  onExitFullscreen?: () => void;
}) {
  const { t } = useI18n();
  const { getAnalyser, isPlaying, current, duration } = usePlayer();
  const progressTime = usePlayerProgressTime();
  const currentLyricsRaw = String(current?.meta?.lyrics || "").trim();
  const parsedLrc = useMemo(
    () => parseLrcLyrics(currentLyricsRaw),
    [currentLyricsRaw],
  );
  const currentLrcIdx = useMemo(() => {
    if (!parsedLrc.length) return -1;
    let idx = -1;
    for (let i = 0; i < parsedLrc.length; i += 1) {
      if (progressTime >= parsedLrc[i]!.atSec) idx = i;
      else break;
    }
    return idx;
  }, [parsedLrc, progressTime]);
  const currentLrcText =
    currentLrcIdx >= 0 ? parsedLrc[currentLrcIdx]?.text?.trim() || "" : "";
  const previousLrcText =
    currentLrcIdx > 0 ? parsedLrc[currentLrcIdx - 1]?.text?.trim() || "" : "";
  const karaokeLines = useMemo(
    () =>
      resolveKaraokeLines(
        currentLyricsRaw,
        progressTime,
        duration,
        current?.title || "",
      ),
    [current?.title, currentLyricsRaw, duration, progressTime],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const cRef = useRef<HTMLCanvasElement>(null);
  const [expandedState, setExpandedState] = useState(false);
  const expanded = fullscreenOnly || expandedState;
  const engineRef = useRef(new VizCanvasEngine());
  const visibleRef = useRef(
    typeof document !== "undefined" ? !document.hidden : true,
  );
  const inViewRef = useRef(true);
  const lastDrawRef = useRef(0);

  const collapse = useCallback(() => {
    if (fullscreenOnly) onExitFullscreen?.();
    else setExpandedState(false);
  }, [fullscreenOnly, onExitFullscreen]);

  const toggleExpanded = useCallback(() => {
    if (fullscreenOnly) {
      onExitFullscreen?.();
      return;
    }
    setExpandedState((v) => !v);
  }, [fullscreenOnly, onExitFullscreen]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, collapse]);

  useEffect(() => {
    if (!expanded || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  useEffect(() => {
    engineRef.current.resetForMode(mode);
  }, [mode]);

  useEffect(() => {
    const c = cRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let timerId = 0;
    let backingScale = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const dpr = () => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

    const clearLoop = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timerId);
      raf = 0;
      timerId = 0;
    };

    const scheduleNext = (delayMs: number) => {
      if (delayMs <= 4) {
        raf = requestAnimationFrame(step);
        return;
      }
      timerId = window.setTimeout(() => {
        timerId = 0;
        raf = requestAnimationFrame(step);
      }, delayMs);
    };

    const size = () => {
      const p = c.parentElement;
      const lw = p ? p.clientWidth : 400;
      const lh = p ? Math.max(100, p.clientHeight || 200) : 200;
      let s = dpr();
      if (expanded) {
        s = Math.min(s, mode === "signals" ? 1.38 : 1.52);
      } else {
        s = canvasDprCap({ lite: true });
      }
      backingScale = s;
      c.width = lw * s;
      c.height = lh * s;
      c.style.width = `${lw}px`;
      c.style.height = `${lh}px`;
      ctx.setTransform(s, 0, 0, s, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    if (c.parentElement) ro.observe(c.parentElement);

    const shouldPauseLoop = () =>
      shouldPauseBackgroundVisualizersForPlectr() ||
      shouldPauseListenStageVisualizers();

    const step = (t: number) => {
      raf = 0;
      if (
        !visibleRef.current ||
        !inViewRef.current ||
        shouldPauseLoop()
      ) {
        return;
      }
      const cadence = vizLoopCadence({ expanded, isPlaying });
      if (t - lastDrawRef.current >= cadence.minFrameIntervalMs) {
        lastDrawRef.current = t;
        const w = c.width / backingScale;
        const h = c.height / backingScale;
        engineRef.current.drawFrame(ctx, {
          width: w,
          height: h,
          mode,
          analyser: isPlaying ? getAnalyser() : null,
          isPlaying,
          expanded,
        });
      }
      const wait = Math.max(
        1,
        cadence.minFrameIntervalMs - (performance.now() - lastDrawRef.current),
      );
      scheduleNext(wait);
    };

    const syncRhythmPause = () => {
      if (shouldPauseLoop()) {
        clearLoop();
        return;
      }
      if (visibleRef.current && inViewRef.current && raf === 0 && timerId === 0) {
        scheduleNext(0);
      }
    };

    const io =
      typeof IntersectionObserver !== "undefined" && wrapRef.current
        ? new IntersectionObserver(
            ([entry]) => {
              inViewRef.current = Boolean(entry?.isIntersecting);
              syncRhythmPause();
            },
            { rootMargin: "40px" },
          )
        : null;
    if (io && wrapRef.current) io.observe(wrapRef.current);

    const onVis = () => {
      visibleRef.current = !document.hidden;
      syncRhythmPause();
    };
    document.addEventListener("visibilitychange", onVis);
    const unsubForeground = subscribeAppForeground((fg) => {
      visibleRef.current = fg;
      syncRhythmPause();
    });

    const unsubRhythm = subscribeRhythmModeOpen(syncRhythmPause);
    const unsubSurface = subscribeVisualSurfaceActive(syncRhythmPause);
    const layoutMq = window.matchMedia(MOBILE_LAYOUT_MQ);
    layoutMq.addEventListener("change", syncRhythmPause);

    visibleRef.current = !document.hidden;
    if (
      visibleRef.current &&
      inViewRef.current &&
      !shouldPauseLoop()
    ) {
      scheduleNext(0);
    }
    return () => {
      clearLoop();
      document.removeEventListener("visibilitychange", onVis);
      unsubForeground();
      unsubRhythm();
      unsubSurface();
      layoutMq.removeEventListener("change", syncRhythmPause);
      io?.disconnect();
      ro.disconnect();
    };
  }, [getAnalyser, isPlaying, mode, expanded]);

  const wrap = (
    <div
      className={`viz-wrap ${expanded ? "is-expanded" : ""}${
        mode === "karaoke" ? " is-karaoke" : ""
      }`}
      ref={wrapRef}
      role="button"
      tabIndex={0}
      aria-label={
        expanded
          ? t("player.vizCollapseAria")
          : t("player.vizExpandAria")
      }
      onClick={() => toggleExpanded()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleExpanded();
        }
      }}
    >
      <canvas className="viz-canvas" ref={cRef} />
      {mode === "karaoke" && karaokeLines.current ? (
        <div className="viz-karaoke-overlay" aria-live="polite">
          {expanded && karaokeLines.previous ? (
            <p className="viz-karaoke-overlay__line viz-karaoke-overlay__line--prev">
              {karaokeLines.previous}
            </p>
          ) : null}
          <p className="viz-karaoke-overlay__line viz-karaoke-overlay__line--current">
            {karaokeLines.current}
          </p>
          {expanded && karaokeLines.next ? (
            <p className="viz-karaoke-overlay__line viz-karaoke-overlay__line--next">
              {karaokeLines.next}
            </p>
          ) : null}
        </div>
      ) : expanded && currentLrcText ? (
        <div className="viz-lyrics-overlay" aria-live="polite">
          {previousLrcText ? (
            <p className="viz-lyrics-overlay__prev">{previousLrcText}</p>
          ) : null}
          <p className="viz-lyrics-overlay__current">{currentLrcText}</p>
        </div>
      ) : null}
    </div>
  );

  if (fullscreenOnly) {
    if (typeof document === "undefined") return null;
    return createPortal(wrap, document.body);
  }

  if (expanded && typeof document !== "undefined") {
    return (
      <>
        <div className="listen-stage__viz-placeholder" aria-hidden />
        {createPortal(wrap, document.body)}
      </>
    );
  }

  return wrap;
}
