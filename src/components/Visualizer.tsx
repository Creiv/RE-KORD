import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../context/PlayerContext";
import { usePlayerProgressTime } from "../hooks/usePlayerProgressTime";
import { useI18n } from "../i18n/useI18n";
import {
  shouldPauseBackgroundVisualizersForPlectr,
  subscribeRhythmModeOpen,
} from "../hooks/useRhythmModeOpen";
import { MOBILE_LAYOUT_MQ } from "../lib/breakpoints";
import { parseLrcLyrics, resolveKaraokeLines } from "../lib/karaokeLyrics";
import { VizCanvasEngine } from "../lib/vizCanvasEngine";
import type { VizMode } from "../types";

export function Visualizer({ mode }: { mode: VizMode }) {
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
  const [expanded, setExpanded] = useState(false);
  const engineRef = useRef(new VizCanvasEngine());
  const visibleRef = useRef(
    typeof document !== "undefined" ? !document.hidden : true,
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

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
    let backingScale = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const dpr = () => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

    const size = () => {
      const p = c.parentElement;
      const lw = p ? p.clientWidth : 400;
      const lh = p ? Math.max(100, p.clientHeight || 200) : 200;
      let s = dpr();
      if (expanded) {
        s = Math.min(s, mode === "signals" ? 1.38 : 1.52);
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

    const onVis = () => {
      visibleRef.current = !document.hidden;
      if (
        visibleRef.current &&
        !shouldPauseBackgroundVisualizersForPlectr() &&
        raf === 0
      ) {
        raf = requestAnimationFrame(step);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    const syncRhythmPause = () => {
      if (shouldPauseBackgroundVisualizersForPlectr()) {
        cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      if (visibleRef.current && raf === 0) {
        raf = requestAnimationFrame(step);
      }
    };

    const unsubRhythm = subscribeRhythmModeOpen(syncRhythmPause);
    const layoutMq = window.matchMedia(MOBILE_LAYOUT_MQ);
    layoutMq.addEventListener("change", syncRhythmPause);

    const step = () => {
      if (!visibleRef.current || shouldPauseBackgroundVisualizersForPlectr()) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(step);
      const w = c.width / backingScale;
      const h = c.height / backingScale;
      engineRef.current.drawFrame(ctx, {
        width: w,
        height: h,
        mode,
        analyser: getAnalyser(),
        isPlaying,
        expanded,
      });
    };

    visibleRef.current = !document.hidden;
    if (visibleRef.current && !shouldPauseBackgroundVisualizersForPlectr()) {
      raf = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      unsubRhythm();
      layoutMq.removeEventListener("change", syncRhythmPause);
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
