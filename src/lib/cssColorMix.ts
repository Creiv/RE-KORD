export type Rgba = { r: number; g: number; b: number; a: number };

function clampAlpha(a: number): string {
  return Math.max(0, Math.min(1, a)).toFixed(4).replace(/\.?0+$/, "") || "0";
}

export function rgbaString(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampAlpha(c.a)})`;
}

export function parseCssColor(raw: string): Rgba | null {
  const s = raw.trim();
  if (!s) return null;

  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
        : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = s.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgb) {
    return {
      r: Math.round(Number(rgb[1])),
      g: Math.round(Number(rgb[2])),
      b: Math.round(Number(rgb[3])),
      a: rgb[4] != null ? Number(rgb[4]) : 1,
    };
  }

  /* Chromium recenti risolvono color-mix() in "color(srgb r g b / a)"
     (canali 0–1, alpha opzionale anche in percentuale). */
  const colorFn = s.match(
    /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/i,
  );
  if (colorFn) {
    const alphaRaw = colorFn[4];
    const alpha =
      alphaRaw == null
        ? 1
        : colorFn[5] === "%"
          ? Number(alphaRaw) / 100
          : Number(alphaRaw);
    return {
      r: Math.round(Number(colorFn[1]) * 255),
      g: Math.round(Number(colorFn[2]) * 255),
      b: Math.round(Number(colorFn[3]) * 255),
      a: alpha,
    };
  }

  return null;
}

/** Equivalente semplificato di color-mix(in srgb, …) con pesi percentuali. */
export function mixSrgbColors(c1: Rgba, w1: number, c2: Rgba, w2: number): string {
  const total = w1 + w2;
  if (total <= 0) return rgbaString(c1);
  const p1 = w1 / total;
  const p2 = w2 / total;
  return rgbaString({
    r: Math.round(c1.r * p1 + c2.r * p2),
    g: Math.round(c1.g * p1 + c2.g * p2),
    b: Math.round(c1.b * p1 + c2.b * p2),
    a: c1.a * p1 + c2.a * p2,
  });
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

export function mixSrgbWithTransparent(color: Rgba, colorWeightPct: number): string {
  const w1 = Math.max(0, Math.min(100, colorWeightPct));
  return mixSrgbColors(color, w1, TRANSPARENT, 100 - w1);
}

function isFullyTransparent(bg: string): boolean {
  return !bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)";
}

function alphaFromBg(bg: string): number {
  const c = parseCssColor(bg);
  return c?.a ?? 0;
}

/**
 * Alcuni WebView (es. handheld Android datati) espongono color-mix via CSS.supports
 * ma lo renderizzano come trasparente. Probe visivo sul DOM reale.
 */
export function probeColorMixWorks(): boolean {
  if (typeof document === "undefined") return true;

  const root = document.documentElement;
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;left:-9999px;visibility:hidden;pointer-events:none";

  root.appendChild(el);

  el.style.backgroundColor = "color-mix(in srgb, rgb(0, 0, 0) 100%, transparent)";
  let bg = getComputedStyle(el).backgroundColor;
  if (isFullyTransparent(bg)) {
    root.removeChild(el);
    return false;
  }

  el.style.backgroundColor =
    "color-mix(in srgb, rgba(18, 30, 46, 0.9) 62%, transparent)";
  bg = getComputedStyle(el).backgroundColor;
  root.removeChild(el);

  if (isFullyTransparent(bg)) return false;
  return alphaFromBg(bg) > 0.12;
}

export function isColorMixBroken(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.colorMix === "0";
}

export function applyColorMixCompatDataset(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.colorMix = probeColorMixWorks() ? "1" : "0";
}
