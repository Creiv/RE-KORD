import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeLibraryTrack,
  prefetchRhythmChart,
  RhythmAnalyzeError,
} from "../lib/analyzeLibraryTrack";
import { getCachedChart } from "../lib/chartCache";
import { sanitizeChartSetForRekord } from "../lib/chartSanitize";
import type { ChartSet } from "../types";
import type { EnrichedTrack } from "../../types";

export type RhythmChartPhase = "idle" | "loading" | "ready" | "error";

export function useRhythmChart(track: EnrichedTrack | null) {
  const loadGenRef = useRef(0);

  const [phase, setPhase] = useState<RhythmChartPhase>("idle");
  const [chartSet, setChartSet] = useState<ChartSet | null>(null);
  const [chartRelPath, setChartRelPath] = useState<string | null>(null);
  const [loadMessage, setLoadMessage] = useState("");
  const [errorCode, setErrorCode] = useState<
    "fetch" | "decode" | "sparse" | "timeout" | null
  >(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setChartSet(null);
    setChartRelPath(null);
    setLoadMessage("");
    setErrorCode(null);
  }, []);

  useEffect(() => {
    if (!track) {
      const timer = window.setTimeout(reset, 0);
      return () => window.clearTimeout(timer);
    }

    const relPath = track.relPath;
    const gen = ++loadGenRef.current;
    const cached = getCachedChart(relPath);
    if (cached) {
      const timer = window.setTimeout(() => {
        if (loadGenRef.current !== gen) return;
        setChartSet(sanitizeChartSetForRekord(cached));
        setChartRelPath(relPath);
        setPhase("ready");
        setErrorCode(null);
        prefetchRhythmChart(track);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const abort = new AbortController();

    const runAnalyze = () => {
      if (abort.signal.aborted || loadGenRef.current !== gen) return;
      setPhase("loading");
      setErrorCode(null);
      setLoadMessage("fetch");
      void (async () => {
        try {
          const raw = await analyzeLibraryTrack(
            track,
            (_p, message) => {
              if (!abort.signal.aborted && loadGenRef.current === gen) {
                setLoadMessage(message);
              }
            },
            abort.signal,
          );
          if (abort.signal.aborted || loadGenRef.current !== gen) return;
          setChartSet(sanitizeChartSetForRekord(raw));
          setChartRelPath(relPath);
          setPhase("ready");
          setErrorCode(null);
          prefetchRhythmChart(track);
        } catch (err) {
          if (abort.signal.aborted || loadGenRef.current !== gen) return;
          if (err instanceof RhythmAnalyzeError) {
            setErrorCode(err.code);
          } else {
            setErrorCode("decode");
          }
          setPhase("error");
        }
      })();
    };

    let timer = 0;
    let idleId: number | undefined;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(runAnalyze, { timeout: 200 });
    } else {
      timer = window.setTimeout(runAnalyze, 0);
    }

    return () => {
      if (timer) window.clearTimeout(timer);
      if (idleId !== undefined && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
      abort.abort();
    };
  }, [track, track?.relPath, reset]);

  return { phase, chartSet, chartRelPath, loadMessage, errorCode, reset };
}
