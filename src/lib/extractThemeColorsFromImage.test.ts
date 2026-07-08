import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  extractThemeColorsFromPixels,
} from "./extractThemeColorsFromImage";

function fill(w: number, h: number, rgb: { r: number; g: number; b: number }) {
  return Array.from({ length: w * h }, () => rgb);
}

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function hueOf({ r, g, b }: { r: number; g: number; b: number }): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  return (h + 360) % 360;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("extractThemeColorsFromPixels", () => {
  it("returns valid hex colors for a solid field", () => {
    const colors = extractThemeColorsFromPixels(fill(32, 32, { r: 20, g: 40, b: 80 }));
    expect(colors).not.toBeNull();
    for (const key of ["bg", "section", "accent", "accent2"] as const) {
      expect(colors![key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps bg dark and section slightly lighter on dark images", () => {
    const colors = extractThemeColorsFromPixels(fill(48, 48, { r: 18, g: 22, b: 34 }));
    expect(colors).not.toBeNull();
    const bg = hexToRgb(colors!.bg);
    const section = hexToRgb(colors!.section);
    expect(Math.max(bg.r, bg.g, bg.b)).toBeLessThan(80);
    expect(section.r + section.g + section.b).toBeGreaterThan(bg.r + bg.g + bg.b);
  });

  it("keeps bg light on light images", () => {
    const colors = extractThemeColorsFromPixels(fill(48, 48, { r: 235, g: 238, b: 244 }));
    expect(colors).not.toBeNull();
    const bg = hexToRgb(colors!.bg);
    expect(Math.min(bg.r, bg.g, bg.b)).toBeGreaterThan(180);
  });

  it("recovers the dominant saturated hue as accent", () => {
    const pixels = [
      ...fill(40, 40, { r: 15, g: 18, b: 26 }),
      ...fill(14, 14, { r: 235, g: 110, b: 40 }), // arancio
      ...fill(8, 8, { r: 40, g: 170, b: 250 }), // azzurro
    ];
    const colors = extractThemeColorsFromPixels(pixels);
    expect(colors).not.toBeNull();
    const accentHue = hueOf(hexToRgb(colors!.accent));
    expect(hueDist(accentHue, 25)).toBeLessThan(35);
  });

  it("picks hue-distinct accents on multicolor samples", () => {
    const pixels = [
      ...fill(20, 20, { r: 12, g: 18, b: 28 }),
      ...fill(10, 10, { r: 240, g: 90, b: 40 }),
      ...fill(10, 10, { r: 40, g: 180, b: 255 }),
    ];
    const colors = extractThemeColorsFromPixels(pixels);
    expect(colors).not.toBeNull();
    const h1 = hueOf(hexToRgb(colors!.accent));
    const h2 = hueOf(hexToRgb(colors!.accent2));
    expect(hueDist(h1, h2)).toBeGreaterThan(20);
  });

  it("meets contrast targets against section", () => {
    const pixels = [
      ...fill(36, 36, { r: 14, g: 18, b: 26 }),
      ...fill(4, 4, { r: 22, g: 24, b: 30 }),
    ];
    const colors = extractThemeColorsFromPixels(pixels);
    expect(colors).not.toBeNull();
    const section = hexToRgb(colors!.section);
    expect(contrastRatio(hexToRgb(colors!.accent), section)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hexToRgb(colors!.accent2), section)).toBeGreaterThanOrEqual(3);
  });

  it("returns null when too few pixels", () => {
    expect(extractThemeColorsFromPixels([{ r: 1, g: 2, b: 3 }])).toBeNull();
  });
});
