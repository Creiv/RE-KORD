import { mediaUrl } from "../../lib/api";
import type { EnrichedTrack } from "../../types";
import { analyzeLibraryBuffer } from "./audioAnalysis";
import { getCachedChart, setCachedChart } from "./chartCache";
import { sanitizeChartSetForRekord } from "./chartSanitize";
import { yieldUi } from "./yieldUi";
import type { ChartSet } from "../types";

export type AnalyzeProgress = (progress: number, message: string) => void;

export class RhythmAnalyzeError extends Error {
  readonly code: "fetch" | "decode" | "sparse" | "timeout";

  constructor(code: "fetch" | "decode" | "sparse" | "timeout") {
    super(code);
    this.name = "RhythmAnalyzeError";
    this.code = code;
  }
}

const MIN_NOTES_PER_DIFFICULTY = 12;
const FETCH_TIMEOUT_MS = 120_000;

function chartIsPlayable(chartSet: ChartSet): boolean {
  return Object.values(chartSet.charts).some(
    (chart) => chart.notes.length >= MIN_NOTES_PER_DIFFICULTY
  );
}

function mediaFetchUrl(relPath: string): string {
  const path = mediaUrl(relPath);
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

const prefetchInFlight = new Set<string>();
const analyzeInFlight = new Map<string, Promise<ChartSet>>();

/* ── Analisi nel Worker: la DSP fuori dal main thread (niente stutter nel
   gioco durante il prefetch del brano successivo). Fallback sul main se il
   Worker non è disponibile. ── */
type WorkerResponse =
  | { id: number; ok: true; chartSet: ChartSet }
  | { id: number; ok: false; error: string };

let analysisWorker: Worker | null | undefined;
let workerRequestId = 0;
const workerPending = new Map<
  number,
  { resolve: (c: ChartSet) => void; reject: (e: Error) => void }
>();

function getAnalysisWorker(): Worker | null {
  if (analysisWorker !== undefined) return analysisWorker;
  try {
    analysisWorker = new Worker(
      new URL("./analysisWorker.ts", import.meta.url),
      { type: "module" },
    );
    analysisWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = workerPending.get(event.data.id);
      if (!pending) return;
      workerPending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.chartSet);
      else pending.reject(new Error(event.data.error));
    };
    analysisWorker.onerror = () => {
      for (const pending of workerPending.values()) {
        pending.reject(new Error("worker error"));
      }
      workerPending.clear();
    };
  } catch {
    analysisWorker = null;
  }
  return analysisWorker;
}

/** Copia i canali a blocchi (con yield): ~80MB in un colpo solo
 *  bloccherebbero il main per decine di ms al cambio traccia. */
const COPY_CHUNK_SAMPLES = 1 << 21;

async function buildTransferChannels(
  buffer: AudioBuffer,
): Promise<ArrayBuffer[]> {
  const out: ArrayBuffer[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const src = buffer.getChannelData(ch);
    const dst = new Float32Array(src.length);
    for (let offset = 0; offset < src.length; offset += COPY_CHUNK_SAMPLES) {
      const end = Math.min(src.length, offset + COPY_CHUNK_SAMPLES);
      dst.set(src.subarray(offset, end), offset);
      if (end < src.length) await yieldUi();
    }
    out.push(dst.buffer);
  }
  return out;
}

function analyzeInWorker(
  buffer: AudioBuffer,
  relPath: string,
  title: string,
): Promise<ChartSet> | null {
  const worker = getAnalysisWorker();
  if (!worker) return null;
  return (async () => {
    const channels = await buildTransferChannels(buffer);
    const id = ++workerRequestId;
    return new Promise<ChartSet>((resolve, reject) => {
      workerPending.set(id, { resolve, reject });
      worker.postMessage(
        {
          id,
          relPath,
          title,
          sampleRate: buffer.sampleRate,
          duration: buffer.duration,
          length: buffer.length,
          channels,
        },
        channels,
      );
    });
  })();
}

/** Precarica la chart in cache (es. prossimo brano in coda). */
export function prefetchRhythmChart(track: EnrichedTrack): void {
  const { relPath } = track;
  if (getCachedChart(relPath) || prefetchInFlight.has(relPath)) return;
  prefetchInFlight.add(relPath);
  void analyzeLibraryTrack(track)
    .catch(() => {
      /* best-effort */
    })
    .finally(() => {
      prefetchInFlight.delete(relPath);
    });
}

export async function analyzeLibraryTrack(
  track: EnrichedTrack,
  onProgress?: AnalyzeProgress,
  signal?: AbortSignal
): Promise<ChartSet> {
  const cached = getCachedChart(track.relPath);
  if (cached) {
    onProgress?.(1, "ready");
    return cached;
  }

  const inflight = analyzeInFlight.get(track.relPath);
  if (inflight) {
    return inflight;
  }

  const run = (async (): Promise<ChartSet> => {
  onProgress?.(0.08, "fetch");
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abortHandler = () => controller.abort();
  signal?.addEventListener("abort", abortHandler);

  try {
    const response = await fetch(mediaFetchUrl(track.relPath), {
      credentials: "same-origin",
      cache: "force-cache",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RhythmAnalyzeError("fetch");
    }
    onProgress?.(0.28, "fetch");
    const blob = await response.blob();
    onProgress?.(0.35, "decode");
    await yieldUi();
    const arrayBuffer = await blob.arrayBuffer();
    await yieldUi();
    const ctx = new AudioContext();
    try {
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      onProgress?.(0.55, "analyze");
      await yieldUi();
      const title = track.title || track.relPath;
      const viaWorker = analyzeInWorker(buffer, track.relPath, title);
      const chartSet = viaWorker
        ? await viaWorker.catch(() =>
            // Worker indisponibile o in errore: analisi sul main (chunked)
            analyzeLibraryBuffer(buffer, track.relPath, title),
          )
        : await analyzeLibraryBuffer(buffer, track.relPath, title);
      const playable = sanitizeChartSetForRekord(chartSet);
      if (!chartIsPlayable(playable)) {
        throw new RhythmAnalyzeError("sparse");
      }
      onProgress?.(1, "ready");
      setCachedChart(track.relPath, chartSet);
      return chartSet;
    } finally {
      void ctx.close();
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof RhythmAnalyzeError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new RhythmAnalyzeError("timeout");
    }
    throw new RhythmAnalyzeError("decode");
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortHandler);
  }
  })();

  analyzeInFlight.set(track.relPath, run);
  try {
    return await run;
  } finally {
    analyzeInFlight.delete(track.relPath);
  }
}
