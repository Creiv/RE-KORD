import { useEffect } from "react";
import { customThemeBgImageUrl } from "../lib/api";
import {
  applyCustomThemeBgImageCssVars,
  clearCustomThemeBgImageCssVars,
  normalizeCustomThemeBgImageFit,
} from "../lib/customThemeBgFit";
import {
  applyAnimatedCustomThemeBg,
  clearAnimatedCustomThemeBg,
} from "../lib/customThemeBgLayer";
import { DEFAULT_CUSTOM_THEME } from "../lib/themeCatalog";
import { probeGlassBackdrop } from "../lib/glassBackdrop";
import { isColorMixBroken } from "../lib/cssColorMix";
import {
  applyGlassSurfaceCssVars,
  clearGlassSurfaceCssVars,
} from "../lib/glassCssVars";
import type { CustomThemeSettings, UserSettings } from "../types";

export function normalizeGlassOpacity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 62;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function normalizeHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}

export function normalizeCustomTheme(
  raw: Partial<CustomThemeSettings> | undefined,
): CustomThemeSettings {
  const src = { ...DEFAULT_CUSTOM_THEME, ...(raw ?? {}) };
  const out: CustomThemeSettings = {
    bg: normalizeHexColor(src.bg, DEFAULT_CUSTOM_THEME.bg),
    section: normalizeHexColor(src.section, DEFAULT_CUSTOM_THEME.section),
    accent: normalizeHexColor(src.accent, DEFAULT_CUSTOM_THEME.accent),
    accent2: normalizeHexColor(src.accent2, DEFAULT_CUSTOM_THEME.accent2),
  };
  const bgImage =
    typeof src.bgImage === "string" && src.bgImage.trim()
      ? src.bgImage.trim().toLowerCase().replace(/^jpeg$/, "jpg")
      : null;
  const hasBgImage =
    bgImage === "jpg" ||
    bgImage === "png" ||
    bgImage === "webp" ||
    bgImage === "gif";
  const bgMode: CustomThemeSettings["bgMode"] =
    src.bgMode === "image"
      ? "image"
      : src.bgMode === "color"
        ? "color"
        : hasBgImage
          ? "image"
          : "color";
  out.bgMode = bgMode;
  out.bgImageFit = normalizeCustomThemeBgImageFit(src.bgImageFit);
  if (hasBgImage) {
    out.bgImage = bgImage;
    const rev = Number(src.bgImageRev);
    if (Number.isFinite(rev) && rev >= 1) out.bgImageRev = Math.floor(rev);
  }
  return out;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHexColor(hex, "#000000").slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const ch = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${ch(ca.r * (1 - t) + cb.r * t)}${ch(ca.g * (1 - t) + cb.g * t)}${ch(ca.b * (1 - t) + cb.b * t)}`;
}

const CUSTOM_THEME_VARS = [
  "--bg",
  "--surface",
  "--surface2",
  "--surface3",
  "--border",
  "--border-strong",
  "--text",
  "--muted",
  "--muted-strong",
  "--accent",
  "--accent2",
  "--focus-ring",
  "--page-glow-1",
  "--page-glow-2",
  "--page-lg-1",
  "--page-lg-2",
  "--page-lg-3",
  "--shell-glow-1",
  "--shell-lg-1",
  "--shell-lg-2",
  "--topbar-bg",
  "--surface-elev-a",
  "--surface-elev-b",
  "--hero-rg-1",
  "--hero-rg-2",
  "--hero-lg-1",
  "--hero-lg-2",
  "--art-empty-1",
  "--art-empty-2",
  "--badge-1",
  "--badge-2",
  "--album-fb-1",
  "--album-fb-2",
  "--listen-viz-bg",
  "--glass-1",
  "--glass-2",
  "--nav-active-cool",
  "--segmented-1",
  "--segmented-2",
  "--chip-on",
  "--codebox-bg",
  "--textarea-bg",
  "--text-on-accent",
  "--player-art-fb",
  "--dirlist-hover-bg",
  "--meta-strip-bg",
  "--ghost-input-bg",
  "--shadow-elev-1",
  "--shadow-elev-2",
  "--warning",
  "--danger",
] as const;

export function clearCustomThemeVars(root: HTMLElement) {
  for (const name of CUSTOM_THEME_VARS) root.style.removeProperty(name);
  root.style.removeProperty("color-scheme");
}

/** Luminanza relativa WCAG 2.1 (0–1). */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Se la sezione è chiara, testo e superfici seguono palette chiara. */
function isLightSection(sectionHex: string): boolean {
  return relativeLuminance(sectionHex) > 0.45;
}

/** Sotto questa opacità vetro le card lasciano vedere lo sfondo: il
 *  bianco/nero del testo segue la luminosità dello sfondo, non delle sezioni. */
export const GLASS_INK_FROM_BG_BELOW = 50;

function textOnAccent(accentHex: string): string {
  return relativeLuminance(accentHex) > 0.55
    ? mixHex(accentHex, "#0a0a0a", 0.9)
    : mixHex(accentHex, "#ffffff", 0.94);
}

export function applyCustomThemeVars(
  root: HTMLElement,
  theme: CustomThemeSettings,
  opts?: { inkFromBg?: boolean },
) {
  const bg = theme.bg;
  const section = theme.section;
  const accent = theme.accent;
  const accent2 = theme.accent2;
  const light = isLightSection(opts?.inkFromBg ? bg : section);
  root.style.colorScheme = light ? "light" : "dark";

  if (light) {
    const ink = mixHex(section, "#0f172a", 0.78);
    const inkMuted = mixHex(section, "#475569", 0.52);
    const inkStrong = mixHex(section, "#0f172a", 0.68);
    root.style.setProperty("--bg", bg);
    root.style.setProperty(
      "--surface",
      rgbaFromHex(mixHex(bg, section, 0.52), 0.9),
    );
    root.style.setProperty("--surface2", rgbaFromHex(section, 0.93));
    root.style.setProperty(
      "--surface3",
      rgbaFromHex(mixHex(section, accent2, 0.12), 0.96),
    );
    root.style.setProperty(
      "--border",
      rgbaFromHex(mixHex(accent2, "#1e293b", 0.38), 0.18),
    );
    root.style.setProperty(
      "--border-strong",
      rgbaFromHex(mixHex(accent2, "#0f172a", 0.45), 0.3),
    );
    root.style.setProperty("--text", ink);
    root.style.setProperty("--muted", inkMuted);
    root.style.setProperty("--muted-strong", inkStrong);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent2", accent2);
    root.style.setProperty("--warning", "#b45309");
    root.style.setProperty("--danger", "#c53030");
    root.style.setProperty(
      "--focus-ring",
      `color-mix(in srgb, ${accent2} 52%, #0f172a 32%)`,
    );
    root.style.setProperty(
      "--shadow-elev-1",
      "0 4px 24px rgba(15, 23, 42, 0.08)",
    );
    root.style.setProperty(
      "--shadow-elev-2",
      "0 22px 48px rgba(15, 23, 42, 0.12)",
    );
    root.style.setProperty("--page-glow-1", rgbaFromHex(accent, 0.11));
    root.style.setProperty("--page-glow-2", rgbaFromHex(accent2, 0.1));
    root.style.setProperty("--page-lg-1", mixHex(bg, "#ffffff", 0.94));
    root.style.setProperty("--page-lg-2", mixHex(bg, "#ffffff", 0.98));
    root.style.setProperty(
      "--page-lg-3",
      mixHex(mixHex(bg, section, 0.32), "#ffffff", 0.9),
    );
    root.style.setProperty("--shell-glow-1", rgbaFromHex(accent, 0.06));
    root.style.setProperty(
      "--shell-lg-1",
      rgbaFromHex(mixHex(bg, "#ffffff", 0.06), 0.97),
    );
    root.style.setProperty("--shell-lg-2", mixHex(bg, "#ffffff", 0.02));
    root.style.setProperty(
      "--topbar-bg",
      rgbaFromHex(mixHex(bg, "#ffffff", 0.14), 0.88),
    );
    root.style.setProperty(
      "--surface-elev-a",
      rgbaFromHex(mixHex(section, bg, 0.14), 0.94),
    );
    root.style.setProperty(
      "--surface-elev-b",
      rgbaFromHex(mixHex(bg, section, 0.2), 0.97),
    );
    root.style.setProperty("--hero-rg-1", rgbaFromHex(accent, 0.12));
    root.style.setProperty("--hero-rg-2", rgbaFromHex(accent2, 0.1));
    root.style.setProperty(
      "--hero-lg-1",
      rgbaFromHex(mixHex(section, bg, 0.1), 0.94),
    );
    root.style.setProperty(
      "--hero-lg-2",
      rgbaFromHex(mixHex(bg, section, 0.16), 0.97),
    );
    root.style.setProperty("--art-empty-1", rgbaFromHex(accent, 0.16));
    root.style.setProperty("--art-empty-2", rgbaFromHex(accent2, 0.12));
    root.style.setProperty("--badge-1", rgbaFromHex(accent, 0.2));
    root.style.setProperty("--badge-2", rgbaFromHex(accent2, 0.14));
    root.style.setProperty("--album-fb-1", rgbaFromHex(accent, 0.22));
    root.style.setProperty("--album-fb-2", rgbaFromHex(accent2, 0.15));
    root.style.setProperty(
      "--listen-viz-bg",
      rgbaFromHex(mixHex(bg, "#e2e8f0", 0.5), 0.96),
    );
    root.style.setProperty(
      "--glass-1",
      rgbaFromHex(mixHex(section, "#ffffff", 0.22), 0.88),
    );
    root.style.setProperty(
      "--glass-2",
      rgbaFromHex(mixHex(bg, section, 0.22), 0.92),
    );
    root.style.setProperty("--nav-active-cool", rgbaFromHex(accent2, 0.12));
    root.style.setProperty("--segmented-1", rgbaFromHex(accent, 0.12));
    root.style.setProperty("--segmented-2", rgbaFromHex(accent2, 0.09));
    root.style.setProperty("--chip-on", rgbaFromHex(accent, 0.12));
    root.style.setProperty(
      "--codebox-bg",
      rgbaFromHex(mixHex(bg, "#f8fafc", 0.55), 0.97),
    );
    root.style.setProperty(
      "--textarea-bg",
      rgbaFromHex(mixHex(bg, "#ffffff", 0.62), 0.96),
    );
    root.style.setProperty("--text-on-accent", textOnAccent(accent));
    root.style.setProperty("--player-art-fb", rgbaFromHex(accent2, 0.1));
    root.style.setProperty("--dirlist-hover-bg", rgbaFromHex(accent2, 0.08));
    root.style.setProperty("--meta-strip-bg", "rgba(15, 23, 42, 0.04)");
    root.style.setProperty("--ghost-input-bg", "rgba(15, 23, 42, 0.045)");
    return;
  }

  root.style.setProperty("--bg", bg);
  root.style.setProperty(
    "--surface",
    rgbaFromHex(mixHex(bg, section, 0.58), 0.88),
  );
  root.style.setProperty("--surface2", rgbaFromHex(section, 0.94));
  root.style.setProperty(
    "--surface3",
    rgbaFromHex(mixHex(section, accent2, 0.16), 0.96),
  );
  root.style.setProperty(
    "--border",
    rgbaFromHex(mixHex(accent2, "#ffffff", 0.2), 0.2),
  );
  root.style.setProperty(
    "--border-strong",
    rgbaFromHex(mixHex(accent2, "#ffffff", 0.18), 0.36),
  );
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent2", accent2);
  root.style.setProperty(
    "--focus-ring",
    `color-mix(in srgb, ${accent2} 72%, white 18%)`,
  );
  root.style.setProperty("--page-glow-1", rgbaFromHex(accent, 0.14));
  root.style.setProperty("--page-glow-2", rgbaFromHex(accent2, 0.12));
  root.style.setProperty("--page-lg-1", mixHex(bg, "#000000", 0.26));
  root.style.setProperty("--page-lg-2", bg);
  root.style.setProperty("--page-lg-3", mixHex(bg, section, 0.28));
  root.style.setProperty("--shell-glow-1", rgbaFromHex(accent, 0.07));
  root.style.setProperty(
    "--shell-lg-1",
    rgbaFromHex(mixHex(bg, "#000000", 0.18), 0.98),
  );
  root.style.setProperty("--shell-lg-2", bg);
  root.style.setProperty(
    "--topbar-bg",
    rgbaFromHex(mixHex(bg, "#000000", 0.2), 0.86),
  );
  root.style.setProperty(
    "--surface-elev-a",
    rgbaFromHex(mixHex(section, bg, 0.18), 0.94),
  );
  root.style.setProperty(
    "--surface-elev-b",
    rgbaFromHex(mixHex(bg, section, 0.22), 0.97),
  );
  root.style.setProperty("--hero-rg-1", rgbaFromHex(accent, 0.14));
  root.style.setProperty("--hero-rg-2", rgbaFromHex(accent2, 0.12));
  root.style.setProperty(
    "--hero-lg-1",
    rgbaFromHex(mixHex(section, bg, 0.12), 0.94),
  );
  root.style.setProperty(
    "--hero-lg-2",
    rgbaFromHex(mixHex(bg, section, 0.18), 0.97),
  );
  root.style.setProperty("--art-empty-1", rgbaFromHex(accent, 0.22));
  root.style.setProperty("--art-empty-2", rgbaFromHex(accent2, 0.16));
  root.style.setProperty("--badge-1", rgbaFromHex(accent, 0.24));
  root.style.setProperty("--badge-2", rgbaFromHex(accent2, 0.18));
  root.style.setProperty("--album-fb-1", rgbaFromHex(accent, 0.26));
  root.style.setProperty("--album-fb-2", rgbaFromHex(accent2, 0.18));
  root.style.setProperty(
    "--listen-viz-bg",
    rgbaFromHex(mixHex(bg, "#000000", 0.34), 0.94),
  );
  root.style.setProperty(
    "--glass-1",
    rgbaFromHex(mixHex(section, bg, 0.24), 0.9),
  );
  root.style.setProperty(
    "--glass-2",
    rgbaFromHex(mixHex(bg, section, 0.2), 0.94),
  );
  root.style.setProperty("--nav-active-cool", rgbaFromHex(accent2, 0.09));
  root.style.setProperty("--segmented-1", rgbaFromHex(accent, 0.11));
  root.style.setProperty("--segmented-2", rgbaFromHex(accent2, 0.08));
  root.style.setProperty("--chip-on", rgbaFromHex(accent, 0.11));
  root.style.setProperty(
    "--codebox-bg",
    rgbaFromHex(mixHex(bg, "#000000", 0.35), 0.95),
  );
  root.style.setProperty(
    "--textarea-bg",
    rgbaFromHex(mixHex(bg, "#000000", 0.25), 0.95),
  );
  root.style.setProperty("--player-art-fb", rgbaFromHex(accent2, 0.08));
  root.style.setProperty("--dirlist-hover-bg", rgbaFromHex(accent2, 0.07));
  root.style.setProperty("--meta-strip-bg", rgbaFromHex(accent2, 0.06));
  root.style.setProperty("--ghost-input-bg", rgbaFromHex("#ffffff", 0.045));
  root.style.removeProperty("--text");
  root.style.removeProperty("--muted");
  root.style.removeProperty("--muted-strong");
  root.style.removeProperty("--text-on-accent");
  root.style.removeProperty("--warning");
  root.style.removeProperty("--danger");
  root.style.removeProperty("--shadow-elev-1");
  root.style.removeProperty("--shadow-elev-2");
}

/** Applica dataset e variabili vetro dopo che --glass-1 del tema è sul DOM. */
export function syncGlassSurfaceDom(
  root: HTMLElement,
  settings: UserSettings,
): void {
  if (!settings.glassSurfaces) {
    delete root.dataset.glassSurfaces;
    delete root.dataset.glassBackdrop;
    root.style.removeProperty("--glass-user-opacity");
    clearGlassSurfaceCssVars(root);
    return;
  }
  root.dataset.glassSurfaces = "1";
  const opacity = normalizeGlassOpacity(settings.glassOpacity);
  root.style.setProperty("--glass-user-opacity", String(opacity / 100));
  const useJsGlass =
    isColorMixBroken() || root.dataset.rekordClient === "1";
  const applyJsGlass = () => {
    if (useJsGlass) applyGlassSurfaceCssVars(root, opacity);
    else clearGlassSurfaceCssVars(root);
  };
  applyJsGlass();
  if (useJsGlass && !root.style.getPropertyValue("--glass-fill-page").trim()) {
    requestAnimationFrame(applyJsGlass);
  }
}

export function useThemeDomEffects(settings: UserSettings) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    if (settings.theme === "custom") {
      const inkFromBg =
        settings.glassSurfaces &&
        settings.glassOpacity < GLASS_INK_FROM_BG_BELOW;
      applyCustomThemeVars(
        root,
        settings.customTheme ?? DEFAULT_CUSTOM_THEME,
        { inkFromBg },
      );
    } else {
      clearCustomThemeVars(root);
    }
    const applyGlass = () => syncGlassSurfaceDom(root, settings);
    applyGlass();
    requestAnimationFrame(applyGlass);
  }, [
    settings,
    settings.customTheme,
    settings.theme,
    settings.glassSurfaces,
    settings.glassOpacity,
  ]);

  useEffect(() => {
    const root = document.documentElement;
    const custom = settings.customTheme;
    const useBgImage =
      settings.theme === "custom" &&
      custom?.bgMode === "image" &&
      Boolean(custom.bgImage);
    if (useBgImage) {
      const url = customThemeBgImageUrl(custom.bgImageRev ?? undefined);
      applyCustomThemeBgImageCssVars(root, custom.bgImageFit);
      root.dataset.customBgImage = "1";
      if (custom.bgImage === "gif") {
        applyAnimatedCustomThemeBg(root, url, custom.bgImageFit);
        if (root.dataset.customBgGifRepeat === "1") {
          root.style.setProperty("--page-bg-image", `url("${url}")`);
        } else {
          root.style.removeProperty("--page-bg-image");
        }
      } else {
        clearAnimatedCustomThemeBg(root);
        root.style.setProperty("--page-bg-image", `url("${url}")`);
      }
      return;
    }
    root.style.removeProperty("--page-bg-image");
    clearCustomThemeBgImageCssVars(root);
    clearAnimatedCustomThemeBg(root);
    delete root.dataset.customBgImage;
  }, [settings, settings.customTheme, settings.theme]);

  useEffect(() => {
    const root = document.documentElement;
    syncGlassSurfaceDom(root, settings);
  }, [
    settings,
    settings.glassSurfaces,
    settings.glassOpacity,
    settings.theme,
    settings.customTheme,
  ]);

  useEffect(() => {
    if (!settings.glassSurfaces) return;
    let cancelled = false;
    const root = document.documentElement;
    void probeGlassBackdrop().then((works) => {
      if (cancelled) return;
      root.dataset.glassBackdrop = works ? "1" : "0";
      syncGlassSurfaceDom(root, settings);
    });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  useEffect(() => {
    document.documentElement.lang =
      settings.locale === "it" ? "it" : "en";
  }, [settings.locale]);

  useEffect(() => {
    document.documentElement.dataset.trackChangeTransitions =
      settings.audioCrossfadeSec > 0 ? "1" : "0";
  }, [settings.audioCrossfadeSec]);
}
