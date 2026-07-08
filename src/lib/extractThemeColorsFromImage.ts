export type Rgb = { r: number; g: number; b: number };

export type ExtractedThemeColors = {
  bg: string;
  section: string;
  accent: string;
  accent2: string;
};

type Hsl = { h: number; s: number; l: number };

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  return { h: (h + 360) % 360, s: Math.min(1, s), l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (h < 60) {
    rn = c;
    gn = x;
  } else if (h < 120) {
    rn = x;
    gn = c;
  } else if (h < 180) {
    gn = c;
    bn = x;
  } else if (h < 240) {
    gn = x;
    bn = c;
  } else if (h < 300) {
    rn = x;
    bn = c;
  } else {
    rn = c;
    bn = x;
  }
  return { r: (rn + m) * 255, g: (gn + m) * 255, b: (bn + m) * 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const ch = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function wcagLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = wcagLuminance(a);
  const l2 = wcagLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hueDistDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

type Cluster = { rgb: Rgb; count: number; hsl: Hsl };

/** Istogramma 32 livelli/canale con colore medio reale per bucket (non il centro
 *  del bucket): preserva le tinte effettive dell'immagine. */
function buildClusters(pixels: Rgb[]): Cluster[] {
  const buckets = new Map<
    number,
    { r: number; g: number; b: number; count: number }
  >();
  for (const p of pixels) {
    const key = ((p.r >> 3) << 10) | ((p.g >> 3) << 5) | (p.b >> 3);
    let acc = buckets.get(key);
    if (!acc) {
      acc = { r: 0, g: 0, b: 0, count: 0 };
      buckets.set(key, acc);
    }
    acc.r += p.r;
    acc.g += p.g;
    acc.b += p.b;
    acc.count += 1;
  }
  return [...buckets.values()]
    .map((a) => {
      const rgb = { r: a.r / a.count, g: a.g / a.count, b: a.b / a.count };
      return { rgb, count: a.count, hsl: rgbToHsl(rgb) };
    })
    .sort((a, b) => b.count - a.count);
}

/** Regola solo la luminosità (hue/sat conservati) fino al contrasto richiesto. */
function ensureContrastOnSection(seed: Hsl, section: Rgb, minRatio: number): Rgb {
  const direct = hslToRgb(seed);
  if (contrastRatio(direct, section) >= minRatio) return direct;
  const lighten = wcagLuminance(section) < 0.45;
  for (let step = 1; step <= 20; step += 1) {
    const l = lighten
      ? clamp(seed.l + step * 0.035, 0, 0.97)
      : clamp(seed.l - step * 0.035, 0.03, 1);
    const candidate = hslToRgb({ ...seed, l });
    if (contrastRatio(candidate, section) >= minRatio) return candidate;
  }
  return lighten ? { r: 250, g: 250, b: 252 } : { r: 15, g: 23, b: 42 };
}

type HueBin = { score: number; r: number; g: number; b: number; w: number };

/** Raggruppa i cluster saturi in bin di tonalità da 15°: molto più stabile dei
 *  singoli bucket contro il rumore/gradienti (specie nelle GIF). */
function buildAccentHueBins(clusters: Cluster[]): Map<number, HueBin> {
  const bins = new Map<number, HueBin>();
  for (const c of clusters) {
    if (c.hsl.s < 0.22 || c.hsl.l < 0.12 || c.hsl.l > 0.88) continue;
    const bin = Math.round(c.hsl.h / 15) % 24;
    const w = c.count * c.hsl.s ** 1.2;
    let acc = bins.get(bin);
    if (!acc) {
      acc = { score: 0, r: 0, g: 0, b: 0, w: 0 };
      bins.set(bin, acc);
    }
    acc.score += w;
    acc.r += c.rgb.r * w;
    acc.g += c.rgb.g * w;
    acc.b += c.rgb.b * w;
    acc.w += w;
  }
  return bins;
}

function binColor(bin: HueBin): Rgb {
  return { r: bin.r / bin.w, g: bin.g / bin.w, b: bin.b / bin.w };
}

/** Rende l'accent vivido senza stravolgerne la tinta. */
function vivify(rgb: Rgb): Hsl {
  const hsl = rgbToHsl(rgb);
  return {
    h: hsl.h,
    s: clamp(Math.max(hsl.s, 0.5) * 1.08, 0, 1),
    l: clamp(hsl.l, 0.32, 0.68),
  };
}

/** Estrae quattro colori tema coerenti da un campione di pixel (funzione pura). */
export function extractThemeColorsFromPixels(
  pixels: Rgb[],
): ExtractedThemeColors | null {
  if (pixels.length < 16) return null;

  const clusters = buildClusters(pixels);
  const total = pixels.length;

  let lumSum = 0;
  for (const c of clusters) lumSum += c.hsl.l * c.count;
  const darkMood = lumSum / total < 0.5;

  // Sfondo: il colore quieto più diffuso, portato a luminosità "da tema".
  const bgSeed =
    clusters.find((c) => c.hsl.s <= 0.45 && c.count >= total * 0.03)?.hsl ??
    clusters[0].hsl;
  const bgHsl: Hsl = {
    h: bgSeed.h,
    s: clamp(bgSeed.s * 0.9, 0.04, 0.6),
    l: darkMood ? clamp(bgSeed.l, 0.05, 0.14) : clamp(bgSeed.l, 0.86, 0.96),
  };
  const bgRgb = hslToRgb(bgHsl);

  // Sezioni: stessa famiglia dello sfondo con offset di luminosità costante,
  // come i temi del catalogo (superfici leggibili e coese).
  const sectionSeed =
    clusters.find(
      (c) =>
        c.count >= total * 0.02 &&
        hueDistDeg(c.hsl.h, bgHsl.h) < 60 &&
        Math.abs(c.hsl.l - bgSeed.l) > 0.04,
    )?.hsl ?? bgHsl;
  const sectionHsl: Hsl = {
    h: sectionSeed.h,
    s: clamp(Math.max(sectionSeed.s, bgHsl.s) * 0.95, 0.05, 0.62),
    l: darkMood ? clamp(bgHsl.l + 0.07, 0.1, 0.24) : clamp(bgHsl.l - 0.07, 0.76, 0.9),
  };
  const sectionRgb = hslToRgb(sectionHsl);

  // Accent: tonalità dominanti tra i colori saturi.
  const bins = buildAccentHueBins(clusters);
  const rankedBins = [...bins.entries()].sort((a, b) => b[1].score - a[1].score);

  const fallbackAccent: Rgb = darkMood
    ? { r: 255, g: 143, b: 92 }
    : { r: 37, g: 99, b: 235 };
  const fallbackAccent2: Rgb = darkMood
    ? { r: 100, g: 212, b: 255 }
    : { r: 124, g: 58, b: 237 };

  const accentSeedRgb = rankedBins[0] ? binColor(rankedBins[0][1]) : fallbackAccent;
  const accentSeed = vivify(accentSeedRgb);
  const accentRgb = ensureContrastOnSection(accentSeed, sectionRgb, 4.5);
  const accentHue = rgbToHsl(accentRgb).h;

  const secondBin = rankedBins.find(
    ([bin]) => hueDistDeg(bin * 15, accentHue) > 40,
  );
  let accent2Seed = vivify(
    secondBin ? binColor(secondBin[1]) : fallbackAccent2,
  );
  if (hueDistDeg(accent2Seed.h, accentHue) < 20) {
    accent2Seed = { ...accent2Seed, h: (accent2Seed.h + 45) % 360 };
  }
  const accent2Rgb = ensureContrastOnSection(accent2Seed, sectionRgb, 3);

  return {
    bg: rgbToHex(bgRgb),
    section: rgbToHex(sectionRgb),
    accent: rgbToHex(accentRgb),
    accent2: rgbToHex(accent2Rgb),
  };
}

function samplePixelsFromSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSize: number,
): Rgb[] {
  const scale = Math.min(1, maxSize / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const pixels: Rgb[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  return pixels;
}

interface VideoFrameLike {
  displayWidth: number;
  displayHeight: number;
  close(): void;
}

interface ImageDecoderLike {
  decode(opts: { frameIndex: number }): Promise<{ image: VideoFrameLike }>;
  tracks: {
    ready: Promise<void>;
    selectedTrack: { frameCount: number } | null;
  };
  close?: () => void;
}

interface ImageDecoderCtor {
  new (init: { data: ArrayBuffer; type: string }): ImageDecoderLike;
}

/** GIF animate: campiona fino a 5 frame distribuiti sull'intera animazione
 *  (WebCodecs, dove disponibile), così la palette riflette tutta la GIF e non
 *  solo il primo frame. */
async function sampleGifPixels(blob: Blob, maxFrames = 5): Promise<Rgb[]> {
  const ImageDecoderClass = (
    globalThis as { ImageDecoder?: ImageDecoderCtor }
  ).ImageDecoder;
  if (!ImageDecoderClass) return [];
  let decoder: ImageDecoderLike | null = null;
  try {
    decoder = new ImageDecoderClass({
      data: await blob.arrayBuffer(),
      type: "image/gif",
    });
    await decoder.tracks.ready;
    const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1;
    const picks = Math.min(maxFrames, Math.max(1, frameCount));
    const pixels: Rgb[] = [];
    for (let i = 0; i < picks; i += 1) {
      const frameIndex = Math.min(
        frameCount - 1,
        Math.round((i * (frameCount - 1)) / Math.max(1, picks - 1)),
      );
      const { image } = await decoder.decode({ frameIndex });
      try {
        pixels.push(
          ...samplePixelsFromSource(
            image as unknown as CanvasImageSource,
            image.displayWidth,
            image.displayHeight,
            80,
          ),
        );
      } finally {
        image.close();
      }
    }
    return pixels;
  } catch {
    return [];
  } finally {
    decoder?.close?.();
  }
}

async function sampleStaticPixels(blob: Blob): Promise<Rgb[]> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        return samplePixelsFromSource(bitmap, bitmap.width, bitmap.height, 128);
      } finally {
        bitmap.close();
      }
    } catch {
      /* fallback all'elemento <img> sotto */
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      el.src = objectUrl;
    });
    return samplePixelsFromSource(img, img.naturalWidth, img.naturalHeight, 128);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Analizza foto o GIF (multi-frame quando possibile) e restituisce i quattro
 *  colori del tema custom. */
export async function extractThemeColorsFromImageUrl(
  imageUrl: string,
): Promise<ExtractedThemeColors> {
  const response = await fetch(imageUrl, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("IMAGE_LOAD_FAILED");
  const blob = await response.blob();

  let pixels: Rgb[] = [];
  if (blob.type === "image/gif") {
    pixels = await sampleGifPixels(blob);
  }
  if (pixels.length === 0) {
    pixels = await sampleStaticPixels(blob);
  }

  const colors = extractThemeColorsFromPixels(pixels);
  if (!colors) throw new Error("IMAGE_ANALYSIS_EMPTY");
  return colors;
}
