import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_THEME } from "../lib/themeCatalog";
import {
  applyCustomThemeVars,
  clearCustomThemeVars,
  GLASS_INK_FROM_BG_BELOW,
  hexToRgb,
  normalizeCustomTheme,
  normalizeGlassOpacity,
  normalizeHexColor,
} from "./themeManager";

describe("themeManager", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.documentElement;
    clearCustomThemeVars(root);
  });

  afterEach(() => {
    clearCustomThemeVars(root);
    delete root.dataset.theme;
    delete root.dataset.glassSurfaces;
    delete root.dataset.customBgImage;
  });

  it("normalizeHexColor expands 3-char hex and lowercases", () => {
    expect(normalizeHexColor("#ABC", "#000000")).toBe("#aabbcc");
    expect(normalizeHexColor("#a1b2c3", "#000000")).toBe("#a1b2c3");
    expect(normalizeHexColor("nope", "#112233")).toBe("#112233");
  });

  it("normalizeGlassOpacity clamps and rounds", () => {
    expect(normalizeGlassOpacity(150)).toBe(100);
    expect(normalizeGlassOpacity(-5)).toBe(0);
    expect(normalizeGlassOpacity(62.4)).toBe(62);
    expect(normalizeGlassOpacity("x")).toBe(62);
  });

  it("normalizeCustomTheme infers image bgMode from extension", () => {
    const theme = normalizeCustomTheme({
      bgImage: "PNG",
      bgMode: undefined,
    });
    expect(theme.bgMode).toBe("image");
    expect(theme.bgImage).toBe("png");
  });

  it("hexToRgb parses normalized hex", () => {
    expect(hexToRgb("#ff8040")).toEqual({ r: 255, g: 128, b: 64 });
  });

  it("applyCustomThemeVars sets light palette text on bright sections", () => {
    applyCustomThemeVars(root, {
      ...DEFAULT_CUSTOM_THEME,
      bg: "#f8fafc",
      section: "#ffffff",
      accent: "#3b82f6",
      accent2: "#8b5cf6",
    });
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--text").trim()).not.toBe("");
    expect(root.style.getPropertyValue("--accent").trim()).toBe("#3b82f6");
  });

  it("applyCustomThemeVars clears ink vars on dark sections", () => {
    applyCustomThemeVars(root, {
      ...DEFAULT_CUSTOM_THEME,
      bg: "#0b1220",
      section: "#111827",
      accent: "#3b82f6",
      accent2: "#8b5cf6",
    });
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--text").trim()).toBe("");
  });

  it("clearCustomThemeVars removes custom properties", () => {
    applyCustomThemeVars(root, DEFAULT_CUSTOM_THEME);
    clearCustomThemeVars(root);
    expect(root.style.getPropertyValue("--bg").trim()).toBe("");
    expect(root.style.getPropertyValue("color-scheme").trim()).toBe("");
  });

  it("exports GLASS_INK_FROM_BG_BELOW threshold", () => {
    expect(GLASS_INK_FROM_BG_BELOW).toBe(50);
  });
});
