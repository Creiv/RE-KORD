/**
 * Worker di analisi chart Plectr: tutta la DSP (mono mix, FFT-frame stats,
 * onset, BPM, generazione note) gira QUI, fuori dal main thread — niente
 * micro-freeze nel gioco quando parte il prefetch del brano successivo.
 * Il decode resta sul main (decodeAudioData non esiste nei worker); i canali
 * arrivano come ArrayBuffer trasferiti.
 */
import { analyzeLibraryBuffer } from "./audioAnalysis";
import type { ChartSet } from "../types";

export type AnalysisWorkerRequest = {
  id: number;
  relPath: string;
  title: string;
  sampleRate: number;
  duration: number;
  length: number;
  channels: ArrayBuffer[];
};

export type AnalysisWorkerResponse =
  | { id: number; ok: true; chartSet: ChartSet }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { id, relPath, title, sampleRate, duration, length, channels } =
    event.data;
  try {
    const floats = channels.map((c) => new Float32Array(c));
    const audio = {
      length,
      numberOfChannels: floats.length,
      sampleRate,
      duration,
      getChannelData: (channel: number) => floats[channel],
    };
    const chartSet = await analyzeLibraryBuffer(audio, relPath, title);
    const response: AnalysisWorkerResponse = { id, ok: true, chartSet };
    self.postMessage(response);
  } catch (err) {
    const response: AnalysisWorkerResponse = {
      id,
      ok: false,
      error: String((err as Error)?.message || err),
    };
    self.postMessage(response);
  }
};
