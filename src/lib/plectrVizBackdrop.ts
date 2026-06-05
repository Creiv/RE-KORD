import type { Chart } from "../game/types";
import type { VizMode } from "../types";
import { DiscoWallCanvasEngine } from "./discowallCanvasEngine";
import { drawKaraokeLyricsOnCanvas } from "./karaokeCanvasDraw";
import type { KaraokeLines } from "./karaokeLyrics";
import { VizCanvasEngine } from "./vizCanvasEngine";

export type PlectrVizBackdropInput = {
  mode: VizMode;
  analyser: AnalyserNode | null;
  isPlaying: boolean;
  chart: Chart;
  seedKey: string;
  liveTime: number;
  karaoke?: KaraokeLines;
};

export class PlectrVizBackdrop {
  private readonly viz = new VizCanvasEngine();
  private readonly discowall = new DiscoWallCanvasEngine();
  private lastMode: VizMode | null = null;

  /** Attenua lo sfondo animato così le corsie e le note restano leggibili. */
  private dimBackdrop(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    mode: VizMode,
  ): void {
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
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dpr: number,
    input: PlectrVizBackdropInput,
  ): void {
    const { mode, analyser, isPlaying, chart, seedKey, liveTime, karaoke } = input;
    if (mode !== this.lastMode) {
      this.viz.resetForMode(mode === "discowall" || mode === "karaoke" ? "bars" : mode);
      this.lastMode = mode;
    }

    if (mode === "karaoke") {
      ctx.save();
      ctx.globalAlpha = 0.45;
      this.viz.drawFrame(ctx, {
        width,
        height,
        mode: "karaoke",
        analyser,
        isPlaying,
        expanded: false,
      });
      ctx.restore();
      if (karaoke) {
        drawKaraokeLyricsOnCanvas(ctx, width, height, karaoke, {
          centerYRatio: 0.44,
          recessed: true,
        });
      }
      this.dimBackdrop(ctx, width, height, mode);
      return;
    }

    if (mode === "discowall") {
      this.discowall.drawFrame(ctx, {
        width,
        height,
        dpr,
        seedKey,
        bpm: chart.stats?.bpm ?? null,
        notes: chart.notes,
        liveTime,
        analyser,
      });
      this.dimBackdrop(ctx, width, height, mode);
      return;
    }

    ctx.save();
    ctx.globalAlpha = 0.45;
    this.viz.drawFrame(ctx, {
      width,
      height,
      mode,
      analyser,
      isPlaying,
      expanded: false,
    });
    ctx.restore();
    this.dimBackdrop(ctx, width, height, mode);
  }
}
