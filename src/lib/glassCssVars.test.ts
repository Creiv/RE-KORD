import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  applyGlassSurfaceCssVars,
  clearGlassSurfaceCssVars,
} from "./glassCssVars";

describe("applyGlassSurfaceCssVars", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.documentElement;
    root.dataset.theme = "midnight";
    root.style.setProperty("--glass-1", "rgba(18, 30, 46, 0.9)");
    root.style.setProperty("--glass-2", "rgba(12, 21, 33, 0.94)");
    root.style.setProperty("--border", "rgba(120, 140, 160, 0.2)");
    root.style.setProperty("--accent", "rgba(120, 180, 255, 1)");
    root.style.setProperty("--accent2", "rgba(200, 182, 255, 1)");
  });

  afterEach(() => {
    clearGlassSurfaceCssVars(root);
  });

  it("sets opaque-enough glass panel vars", () => {
    applyGlassSurfaceCssVars(root, 62);
    const panel = root.style.getPropertyValue("--glass-panel").trim();
    expect(panel).toMatch(/^rgba\(/);
    expect(panel).not.toBe("rgba(0, 0, 0, 0)");
    expect(root.style.getPropertyValue("--glass-fill-page").trim()).toContain(
      "linear-gradient",
    );
  });
});
