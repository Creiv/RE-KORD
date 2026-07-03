import type { Chart } from "../game/types";
import type { VizMode } from "../types";
import { DiscoWallCanvasEngine } from "./discowallCanvasEngine";
import { VizCanvasEngine } from "./vizCanvasEngine";

export type PlectrVizBackdropInput = {
  mode: VizMode;
  analyser: AnalyserNode | null;
  isPlaying: boolean;
  chart: Chart;
  seedKey: string;
  liveTime: number;
};

/* Lo sfondo animato è dietro un velo scuro: renderizzarlo a piena risoluzione
   e a ogni frame ruba il budget alle note su hardware mobile (misurato: metà
   dei frame persi). Qui gira su un canvas offscreen a risoluzione ridotta e a
   ~30fps; ogni frame del gioco fa solo un drawImage. */
/* matchMedia crea un nuovo MediaQueryList a ogni chiamata: qui viene
   riusato (readBackdropQuality gira a ogni frame del gioco). */
let coarsePointerMq: MediaQueryList | null = null;

function hasCoarsePointer(): boolean {
  if (!coarsePointerMq) {
    coarsePointerMq = window.matchMedia("(pointer: coarse)");
  }
  return coarsePointerMq.matches;
}

function readBackdropQuality(): { scale: number; intervalMs: number } {
  if (typeof window === "undefined") {
    return { scale: 0.5, intervalMs: 32 };
  }
  const mobile = hasCoarsePointer() || window.innerWidth < 520;
  return mobile
    ? { scale: 0.4, intervalMs: 48 }
    : { scale: 0.5, intervalMs: 32 };
}

export class PlectrVizBackdrop {
  private readonly viz = new VizCanvasEngine();
  private readonly discowall = new DiscoWallCanvasEngine();
  private lastMode: VizMode | null = null;
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private offW = 0;
  private offH = 0;
  private lastRenderAt = 0;
  private dimGradient: CanvasGradient | null = null;
  private dimGradientMode: VizMode | null = null;
  private dimGradientHeight = 0;

  /** Attenua lo sfondo animato così le corsie e le note restano leggibili. */
  private dimBackdrop(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    mode: VizMode,
  ): void {
    if (
      !this.dimGradient ||
      this.dimGradientMode !== mode ||
      this.dimGradientHeight !== height
    ) {
      const g = ctx.createLinearGradient(0, 0, 0, height);
      if (mode === "discowall") {
        g.addColorStop(0, "rgba(4, 8, 14, 0.44)");
        g.addColorStop(0.5, "rgba(4, 8, 14, 0.62)");
        g.addColorStop(1, "rgba(4, 8, 14, 0.82)");
      } else {
        g.addColorStop(0, "rgba(4, 8, 14, 0.48)");
        g.addColorStop(0.55, "rgba(4, 8, 14, 0.64)");
        g.addColorStop(1, "rgba(4, 8, 14, 0.86)");
      }
      this.dimGradient = g;
      this.dimGradientMode = mode;
      this.dimGradientHeight = height;
    }
    ctx.fillStyle = this.dimGradient;
    ctx.fillRect(0, 0, width, height);
  }

  private renderOffscreen(
    width: number,
    height: number,
    input: PlectrVizBackdropInput,
    scale: number,
  ): void {
    const { mode, analyser, isPlaying, chart, seedKey, liveTime } = input;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    if (!this.off) {
      this.off = document.createElement("canvas");
      this.offCtx = this.off.getContext("2d");
    }
    if (!this.offCtx) return;
    if (this.off.width !== targetW || this.off.height !== targetH) {
      this.off.width = targetW;
      this.off.height = targetH;
      this.offW = targetW;
      this.offH = targetH;
      this.dimGradient = null;
    }
    const octx = this.offCtx;

    if (mode === "discowall") {
      // DiscoWall rasterizza un ImageData: va disegnato alla risoluzione reale
      // del buffer offscreen, non a width×height con sola scala del contesto.
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.fillStyle = "#04080e";
      octx.fillRect(0, 0, targetW, targetH);
      this.discowall.drawFrame(octx, {
        width: targetW,
        height: targetH,
        dpr: 1,
        seedKey,
        bpm: chart.stats?.bpm ?? null,
        notes: chart.notes,
        liveTime,
        analyser,
      });
      this.dimBackdrop(octx, targetW, targetH, mode);
      return;
    }

    // Stessa geometria del full-res: scala il contesto, non il layout.
    octx.setTransform(
      targetW / width,
      0,
      0,
      targetH / height,
      0,
      0,
    );
    octx.fillStyle = "#04080e";
    octx.fillRect(0, 0, width, height);

    if (mode !== "karaoke") {
      octx.save();
      octx.globalAlpha = 0.45;
      this.viz.drawFrame(octx, {
        width,
        height,
        mode,
        analyser,
        isPlaying,
        expanded: false,
      });
      octx.restore();
      this.dimBackdrop(octx, width, height, mode);
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    _dpr: number,
    input: PlectrVizBackdropInput,
  ): void {
    const { mode } = input;
    if (mode !== this.lastMode) {
      this.viz.resetForMode(mode === "discowall" || mode === "karaoke" ? "bars" : mode);
      this.lastMode = mode;
      this.lastRenderAt = 0;
      this.dimGradient = null;
    }

    const { scale, intervalMs } = readBackdropQuality();
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    const now = performance.now();
    const sizeChanged =
      this.off == null ||
      this.off.width !== targetW ||
      this.off.height !== targetH;
    if (sizeChanged || now - this.lastRenderAt >= intervalMs) {
      this.renderOffscreen(width, height, input, scale);
      this.lastRenderAt = now;
    }
    if (this.off && this.offW > 0 && this.offH > 0) {
      ctx.drawImage(this.off, 0, 0, width, height);
    }
  }
}
