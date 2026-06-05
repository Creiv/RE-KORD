import type { KaraokeLines } from "./karaokeLyrics";

function parseCssColor(raw: string): { r: number; g: number; b: number } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) {
      return {
        r: parseInt(h[0]! + h[0]!, 16),
        g: parseInt(h[1]! + h[1]!, 16),
        b: parseInt(h[2]! + h[2]!, 16),
      };
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      };
    }
    return null;
  }
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]! };
  return null;
}

function mixTextColor(accent: { r: number; g: number; b: number }, textWeight: number) {
  const text = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--text"));
  const base = text ?? { r: 240, g: 244, b: 248 };
  const t = textWeight;
  return {
    r: Math.round(base.r * (1 - t) + accent.r * t),
    g: Math.round(base.g * (1 - t) + accent.g * t),
    b: Math.round(base.b * (1 - t) + accent.b * t),
  };
}

function rgba(c: { r: number; g: number; b: number }, a: number) {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function wrapLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0]!;
  for (let i = 1; i < words.length; i += 1) {
    const next = `${line} ${words[i]}`;
    if (ctx.measureText(next).width <= maxWidth) line = next;
    else {
      lines.push(line);
      line = words[i]!;
    }
  }
  lines.push(line);
  return lines;
}

export type KaraokeCanvasDrawOpts = {
  /** Rapporto verticale (0–1) del centro del blocco testi. */
  centerYRatio?: number;
  /** Testi attenuati, pensati per stare sotto le corsie Plectr. */
  recessed?: boolean;
};

export function drawKaraokeLyricsOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lines: KaraokeLines,
  opts?: KaraokeCanvasDrawOpts,
): void {
  const accent =
    parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--accent")) ??
    { r: 255, g: 143, b: 92 };
  const currentColor = mixTextColor(accent, 0.74);
  const sideColor = mixTextColor(accent, 0.26);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const recessed = opts?.recessed ?? false;
  const padX = Math.max(12, width * 0.06);
  const maxTextW = width - padX * 2;
  const centerY = height * (opts?.centerYRatio ?? 0.24);
  const lineGap = Math.max(14, height * 0.055);

  const drawWrapped = (
    text: string,
    y: number,
    font: string,
    color: string,
    alpha: number,
    bold = false,
  ) => {
    if (!text) return;
    ctx.font = font;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = recessed ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.72)";
    ctx.shadowBlur = recessed ? (bold ? 5 : 3) : bold ? 10 : 6;
    const wrapped = wrapLine(ctx, text, maxTextW);
    const blockH = wrapped.length * lineGap;
    let yy = y - (blockH - lineGap) * 0.5;
    for (const row of wrapped) {
      ctx.fillText(row, width * 0.5, yy);
      yy += lineGap;
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };

  const sideSize = recessed
    ? Math.max(10, Math.min(14, width * 0.03))
    : Math.max(11, Math.min(16, width * 0.034));
  const currentSize = recessed
    ? Math.max(13, Math.min(22, width * 0.05))
    : Math.max(15, Math.min(26, width * 0.058));
  const sideFont = `600 ${sideSize}px Manrope, system-ui, sans-serif`;
  const currentFont = `800 ${currentSize}px Manrope, system-ui, sans-serif`;

  drawWrapped(
    lines.previous,
    centerY - lineGap * 1.35,
    sideFont,
    rgba(sideColor, 1),
    recessed ? 0.34 : 0.5,
  );
  drawWrapped(
    lines.current,
    centerY,
    currentFont,
    rgba(currentColor, 1),
    recessed ? 0.58 : 0.95,
    true,
  );
  drawWrapped(
    lines.next,
    centerY + lineGap * 1.35,
    sideFont,
    rgba(sideColor, 1),
    recessed ? 0.28 : 0.44,
  );

  ctx.restore();
}
