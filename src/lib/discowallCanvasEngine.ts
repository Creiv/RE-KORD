import type { ChartNote } from "../game/types";
import {
  buildPlectrFieldGrid,
  buildTriads,
  burstPoint,
  collectMotifs,
  createSceneStyleWeights,
  frameHues,
  mathPixelHue,
  pixelMathPhase,
  prepareConstellationTaps,
  samplePlectrFieldGrid,
  seededNoise,
  writeSceneStyleWeights,
} from "../views/discowallPlectr";

const MAX_CELLS = 1800;
const MIN_CELL = 9;
const MAX_CELL = 18;

function clamp(v: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

function hashText(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lastNoteIndexAt(notes: ChartNote[], time: number, slack = 0.035): number {
  if (!notes.length) return -1;
  const target = time + slack;
  let lo = 0;
  let hi = notes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid]!.time <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function hslToRgb(h: number, sPct: number, lPct: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const s = clamp(sPct / 100, 0, 1);
  const l = clamp(lPct / 100, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hue < 60) {
    rp = c;
    gp = x;
  } else if (hue < 120) {
    rp = x;
    gp = c;
  } else if (hue < 180) {
    gp = c;
    bp = x;
  } else if (hue < 240) {
    gp = x;
    bp = c;
  } else if (hue < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return [
    (rp + m) * 255 + 0.5 | 0,
    (gp + m) * 255 + 0.5 | 0,
    (bp + m) * 255 + 0.5 | 0,
  ];
}

function blendPixel(
  data: Uint8ClampedArray,
  idx: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const inv = 1 - a;
  data[idx] = (r * a + data[idx]! * inv + 0.5) | 0;
  data[idx + 1] = (g * a + data[idx + 1]! * inv + 0.5) | 0;
  data[idx + 2] = (b * a + data[idx + 2]! * inv + 0.5) | 0;
}

function fillCellRgb(
  data: Uint8ClampedArray,
  bufW: number,
  bufH: number,
  x0: number,
  y0: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const x1 = Math.min(bufW, x0 + size);
  const y1 = Math.min(bufH, y0 + size);
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  for (let py = yStart; py < y1; py += 1) {
    let idx = (py * bufW + xStart) * 4;
    for (let px = xStart; px < x1; px += 1) {
      blendPixel(data, idx, r, g, b, a);
      idx += 4;
    }
  }
}

export type DiscoWallCanvasDrawOptions = {
  width: number;
  height: number;
  dpr: number;
  seedKey: string;
  bpm: number | null;
  notes: ChartNote[];
  liveTime: number;
  analyser: AnalyserNode | null;
};

export class DiscoWallCanvasEngine {
  private pulse = 0;
  private flash = 0;
  private colorNudge = 0;
  private burst = { x: 0.5, y: 0.5 };
  private lastNote = -1;
  private lastLiveEnergy = 0;
  private lastBassEnergy = 0;
  private frameIx = 0;
  private fftScratch: Uint8Array | null = null;
  private frameImage: ImageData | null = null;
  private noiseArr: Float32Array | null = null;
  private grainArr: Float32Array | null = null;
  private xnArr: Float32Array | null = null;
  private ynArr: Float32Array | null = null;
  private cols = 1;
  private rows = 1;
  private cell = 12;
  private pad = 1;
  private bufW = 1;
  private bufH = 1;
  private seed = 0;
  private triads = buildTriads(0, null);
  private notesKey = "";
  private readonly styleW = createSceneStyleWeights();

  resetForNotes(notes: ChartNote[], seedKey: string, bpm: number | null): void {
    const key = `${seedKey}|${notes.length}|${notes[0]?.id ?? 0}`;
    if (key === this.notesKey) return;
    this.notesKey = key;
    this.seed = hashText(seedKey);
    this.triads = buildTriads(this.seed, bpm);
    this.lastNote = -1;
    this.pulse = 0;
    this.flash = 0;
    this.colorNudge = 0;
    this.noiseArr = null;
    this.grainArr = null;
  }

  private layout(width: number, height: number, dpr: number): void {
    const w = Math.max(120, width);
    const h = Math.max(120, height);
    let cell = clamp(Math.round(w / 92), MIN_CELL, MAX_CELL);
    let cols = Math.max(18, Math.floor(w / cell));
    let rows = Math.max(12, Math.floor(h / cell));
    while (cols * rows > MAX_CELLS) {
      cell += 1;
      cols = Math.max(18, Math.floor(w / cell));
      rows = Math.max(12, Math.floor(h / cell));
    }
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.pad = Math.max(1, cell * 0.11);
    this.bufW = Math.round(w * dpr);
    this.bufH = Math.round(h * dpr);
    const n = cols * rows;
    if (!this.noiseArr || this.noiseArr.length !== n) {
      this.noiseArr = new Float32Array(n);
      this.grainArr = new Float32Array(n);
    }
    const noise = this.noiseArr!;
    const grain = this.grainArr!;
    for (let i = 0; i < n; i += 1) {
      noise[i] = seededNoise(this.seed, i);
      grain[i] = seededNoise(this.seed + 31, i);
    }
    if (!this.xnArr || this.xnArr.length !== cols) this.xnArr = new Float32Array(cols);
    if (!this.ynArr || this.ynArr.length !== rows) this.ynArr = new Float32Array(rows);
    const colDenom = cols <= 1 ? 1 : cols - 1;
    const rowDenom = rows <= 1 ? 1 : rows - 1;
    for (let x = 0; x < cols; x += 1) this.xnArr[x] = cols <= 1 ? 0 : x / colDenom;
    for (let y = 0; y < rows; y += 1) this.ynArr[y] = rows <= 1 ? 0 : y / rowDenom;
  }

  private notePulseAt(notes: ChartNote[], time: number): number {
    if (!notes.length) return 0;
    const idx = lastNoteIndexAt(notes, time);
    if (idx > this.lastNote) {
      for (let i = this.lastNote + 1; i <= idx; i += 1) {
        const note = notes[i]!;
        this.flash = Math.max(this.flash, 1);
        this.colorNudge = Math.min(
          1.2,
          this.colorNudge + 0.22 + seededNoise(this.seed, note.id) * 0.18,
        );
        this.burst = burstPoint(note, this.seed);
      }
    }
    this.lastNote = idx;
    let p = 0;
    const k0 = Math.max(0, idx - 3);
    const k1 = Math.min(notes.length, idx + 5);
    for (let k = k0; k < k1; k += 1) {
      const note = notes[k]!;
      const dist = Math.abs(note.time - time);
      if (dist > 0.42) continue;
      const laneBoost = 0.95 + seededNoise(this.seed, note.id) * 0.18;
      p = Math.max(p, Math.pow(1 - dist / 0.42, 2.4) * laneBoost);
    }
    return clamp(p);
  }

  drawFrame(ctx: CanvasRenderingContext2D, opts: DiscoWallCanvasDrawOptions): void {
    const { width, height, dpr, notes, liveTime, analyser, seedKey, bpm } = opts;
    this.resetForNotes(notes, seedKey, bpm);
    this.layout(width, height, dpr);

    this.frameIx += 1;

    let liveEnergy = this.lastLiveEnergy;
    let bassEnergy = this.lastBassEnergy;
    if (analyser && this.frameIx % 2 === 0) {
      const len = Math.min(96, analyser.frequencyBinCount);
      if (!this.fftScratch || this.fftScratch.length < len) {
        this.fftScratch = new Uint8Array(len);
      }
      const scratch = this.fftScratch.subarray(0, len);
      analyser.getByteFrequencyData(scratch as never);
      let sum = 0;
      let bass = 0;
      const bassN = Math.min(12, len);
      for (let i = 0; i < len; i += 1) {
        const v = scratch[i] ?? 0;
        sum += v;
        if (i < bassN) bass += v;
      }
      liveEnergy = sum / (len * 255);
      bassEnergy = bass / (bassN * 255);
      this.lastLiveEnergy = liveEnergy;
      this.lastBassEnergy = bassEnergy;
    }

    const mappedPulse = this.notePulseAt(notes, liveTime);
    const pulseTarget = Math.max(
      liveEnergy * 0.5 + bassEnergy * 0.26,
      mappedPulse * 1.02,
    );
    this.pulse += (pulseTarget - this.pulse) * 0.16;
    this.pulse *= 0.992;
    this.flash *= 0.91;
    this.colorNudge *= 0.965;

    const pulse = this.pulse;
    const flash = this.flash;
    const beatHz = bpm ? bpm / 60 : 1.25;
    const beatIndex = liveTime * beatHz;
    const hasChart = notes.length > 0;
    const hues = frameHues(
      this.triads,
      beatIndex,
      liveTime,
      hasChart ? this.colorNudge : 0,
    );
    const motifs = hasChart ? collectMotifs(notes, liveTime, this.seed) : [];
    const constellationTaps = hasChart
      ? prepareConstellationTaps(motifs, liveTime)
      : [];
    if (hasChart) writeSceneStyleWeights(this.styleW, beatIndex, this.seed);
    const plectrGrid = hasChart
      ? buildPlectrFieldGrid(motifs, this.styleW, liveTime, constellationTaps)
      : null;

    if (!this.frameImage || this.frameImage.width !== this.bufW || this.frameImage.height !== this.bufH) {
      this.frameImage = ctx.createImageData(this.bufW, this.bufH);
    }
    const pixels = this.frameImage.data;
    const [bgR, bgG, bgB] = hslToRgb(228 + (this.seed % 20), 22, 4 + pulse * 1.1);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = bgR;
      pixels[i + 1] = bgG;
      pixels[i + 2] = bgB;
      pixels[i + 3] = 255;
    }

    const burst = this.burst;
    const noise = this.noiseArr!;
    const grain = this.grainArr!;
    const xnRow = this.xnArr!;
    const ynCol = this.ynArr!;

    for (let y = 0; y < this.rows; y += 1) {
      const yn = ynCol[y]!;
      for (let x = 0; x < this.cols; x += 1) {
        const xn = xnRow[x]!;
        const i = y * this.cols + x;
        let field: number;
        let accent = 0;
        let colorW0 = 0.2;
        let colorW1 = 0.2;
        let colorW2 = 0.2;
        if (hasChart && plectrGrid) {
          const sampled = samplePlectrFieldGrid(plectrGrid, xn, yn);
          field = sampled.field;
          accent = sampled.accent;
          colorW0 = sampled.colorW[0];
          colorW1 = sampled.colorW[1];
          colorW2 = sampled.colorW[2];
        } else {
          field = 0.05 + pulse * 0.14 + bassEnergy * 0.06;
        }
        const bdx = xn - burst.x;
        const bdy = yn - burst.y;
        const burstDist = Math.sqrt(bdx * bdx + bdy * bdy);
        const burstHit = hasChart
          ? flash > 0.08
            ? Math.max(0, 1 - burstDist * (3 - flash * 0.7)) ** 1.7
            : 0
          : 0;
        const phase = pixelMathPhase(this.seed, i, beatIndex, field, accent);
        const shimmer = hasChart
          ? 0.08 * (0.5 + 0.5 * Math.sin(phase * 1.25))
          : 0.03 * (0.5 + 0.5 * Math.sin(phase * 1.1));
        field += shimmer;
        const gateThreshold = hasChart
          ? 0.4 - field * 0.18 + Math.sin(phase * 2.1) * 0.05
          : 0.5 - field * 0.12 + Math.sin(phase * 2.1) * 0.04;
        const pixelGate = grain[i]! > gateThreshold;
        const core = clamp(
          field * (hasChart ? 1.08 : 0.92) +
            pulse * (hasChart ? 0.16 : 0.1) +
            bassEnergy * 0.08 +
            burstHit * (0.48 + flash * 0.45) -
            (pixelGate ? 0.1 : 0),
        );
        const coreMin = hasChart ? 0.14 : 0.2;
        const coreGate = hasChart ? 0.34 : 0.4;
        if (core < coreMin || (pixelGate && core < coreGate)) continue;
        const hue =
          mathPixelHue(hues, [colorW0, colorW1, colorW2], phase, accent * 0.2) +
          (noise[i]! - 0.5) * 2.5 +
          burstHit * 4;
        const sat = 44 + clamp(accent + pulse * 0.5) * 26;
        const light = 16 + core * 28 + flash * burstHit * 9;
        const sizeBoost = clamp(core * 0.9 + flash * burstHit * 0.34);
        const s = Math.max(1.2, this.cell - this.pad * 2) * (0.18 + sizeBoost * 0.9);
        const px = (x * this.cell + this.pad * 0.5 + (this.cell - s) * 0.5) * dpr;
        const py = (y * this.cell + this.pad * 0.5 + (this.cell - s) * 0.5) * dpr;
        const sD = Math.max(1, Math.round(s * dpr));
        const [r, g, b] = hslToRgb(hue, sat, light);
        const alpha = clamp(0.11 + core * 0.76, 0.1, 0.88);
        fillCellRgb(pixels, this.bufW, this.bufH, px | 0, py | 0, sD, r, g, b, alpha);
      }
    }

    const prevTransform = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(this.frameImage, 0, 0);
    ctx.setTransform(prevTransform);
    ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
    ctx.fillRect(0, 0, width, height);
  }
}
