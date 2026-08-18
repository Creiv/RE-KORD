/** Theme catalog for picker previews (parity with legacy themeCatalog). */

import {
  isCustomThemeBgImageExt,
  normalizeCustomThemeBgImageFit,
  type CustomThemeBgImageFit,
} from "./customThemeBgFit";

export type { CustomThemeBgImageFit };

export type ThemeGroupId = "dual" | "dark" | "color" | "light" | "custom";

export type CustomThemeBgMode = "color" | "image";

export type CustomThemeSettings = {
  bg: string;
  section: string;
  accent: string;
  accent2: string;
  /** Solid color vs stored account background image. */
  bgMode?: CustomThemeBgMode;
  /** File extension of stored theme-bg (jpg/png/webp/gif). */
  bgImage?: string | null;
  /** Cache-bust revision for the theme-bg URL. */
  bgImageRev?: number | null;
  /** How the background image fills the page. */
  bgImageFit?: CustomThemeBgImageFit;
  /**
   * Optional accent wash: accent1 (→ accent2) gradient top→bottom on the page background.
   * Default off (preferred flat/page-lg look).
   */
  accentWash?: boolean;
};

export type ThemeCatalogEntry = {
  id: string;
  group: ThemeGroupId;
  bg: string;
  section: string;
  accent: string;
  accent2: string;
};

export const DEFAULT_CUSTOM_THEME: CustomThemeSettings = {
  bg: "#08111d",
  section: "#121f31",
  accent: "#ff8f5c",
  accent2: "#64d4ff",
  bgMode: "color",
  bgImageFit: "cover",
  accentWash: false,
};

export const THEME_GROUPS: { id: ThemeGroupId; labelKey: string }[] = [
  { id: "dual", labelKey: "themePicker.groupDual" },
  { id: "dark", labelKey: "themePicker.groupDark" },
  { id: "color", labelKey: "themePicker.groupColor" },
  { id: "light", labelKey: "themePicker.groupLight" },
  { id: "custom", labelKey: "themePicker.groupCustom" },
];

export const THEME_CATALOG: ThemeCatalogEntry[] = [
  {
    id: "midnight",
    group: "dual",
    bg: "#08111d",
    section: "#121f31",
    accent: "#ff8f5c",
    accent2: "#64d4ff",
  },
  {
    id: "sunset",
    group: "color",
    bg: "#141018",
    section: "#341e2c",
    accent: "#ff9b5d",
    accent2: "#ffd16f",
  },
  {
    id: "aurora",
    group: "color",
    bg: "#071116",
    section: "#102830",
    accent: "#4fd4c4",
    accent2: "#78b4ff",
  },
  {
    id: "ember",
    group: "color",
    bg: "#120b08",
    section: "#3a1a12",
    accent: "#ff7a4a",
    accent2: "#ffbe5c",
  },
  {
    id: "forest",
    group: "color",
    bg: "#080f0a",
    section: "#143024",
    accent: "#5ed494",
    accent2: "#9ee8b8",
  },
  {
    id: "neon",
    group: "dual",
    bg: "#0a0618",
    section: "#30184e",
    accent: "#c45cff",
    accent2: "#3dc8ff",
  },
  {
    id: "ocean",
    group: "color",
    bg: "#051a1e",
    section: "#0c3a44",
    accent: "#2dd4bf",
    accent2: "#38bdf8",
  },
  {
    id: "rose",
    group: "color",
    bg: "#170f14",
    section: "#3c2030",
    accent: "#f472b6",
    accent2: "#fda4af",
  },
  {
    id: "slate",
    group: "dark",
    bg: "#0b0f14",
    section: "#1e2838",
    accent: "#3b82f6",
    accent2: "#94a3b8",
  },
  {
    id: "aubergine",
    group: "dark",
    bg: "#0e0e11",
    section: "#262630",
    accent: "#8b5cf6",
    accent2: "#c4b5fd",
  },
  {
    id: "tangerine",
    group: "dark",
    bg: "#0e0e11",
    section: "#262630",
    accent: "#f97316",
    accent2: "#fbbf24",
  },
  {
    id: "carmine",
    group: "dark",
    bg: "#0e0e11",
    section: "#262630",
    accent: "#e11d48",
    accent2: "#fb7185",
  },
  {
    id: "prism",
    group: "dual",
    bg: "#07090b",
    section: "#162022",
    accent: "#a3ff3f",
    accent2: "#ff4fd8",
  },
  {
    id: "slate-light",
    group: "light",
    bg: "#f4f6f9",
    section: "#e4e9f2",
    accent: "#3b82f6",
    accent2: "#94a3b8",
  },
  {
    id: "aubergine-light",
    group: "light",
    bg: "#f7f5fc",
    section: "#ebe6f7",
    accent: "#8b5cf6",
    accent2: "#c4b5fd",
  },
  {
    id: "tangerine-light",
    group: "light",
    bg: "#fdfaf5",
    section: "#f7ede0",
    accent: "#f97316",
    accent2: "#fbbf24",
  },
  {
    id: "carmine-light",
    group: "light",
    bg: "#fdf5f6",
    section: "#f8e5e9",
    accent: "#e11d48",
    accent2: "#fb7185",
  },
  {
    id: "custom",
    group: "custom",
    ...DEFAULT_CUSTOM_THEME,
  },
];

export function catalogEntry(id: string): ThemeCatalogEntry {
  return THEME_CATALOG.find((e) => e.id === id) ?? THEME_CATALOG[0]!;
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
  raw: Partial<CustomThemeSettings> | undefined | null,
): CustomThemeSettings {
  const src = { ...DEFAULT_CUSTOM_THEME, ...(raw ?? {}) };
  const out: CustomThemeSettings = {
    bg: normalizeHexColor(src.bg, DEFAULT_CUSTOM_THEME.bg),
    section: normalizeHexColor(src.section, DEFAULT_CUSTOM_THEME.section),
    accent: normalizeHexColor(src.accent, DEFAULT_CUSTOM_THEME.accent),
    accent2: normalizeHexColor(src.accent2, DEFAULT_CUSTOM_THEME.accent2),
    accentWash: src.accentWash === true,
  };
  const bgImage =
    typeof src.bgImage === "string" && src.bgImage.trim()
      ? src.bgImage.trim().toLowerCase().replace(/^jpeg$/, "jpg")
      : null;
  const hasBgImage = isCustomThemeBgImageExt(bgImage);
  const bgMode: CustomThemeBgMode =
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
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

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const CUSTOM_RK_VARS = [
  "--rk-bg",
  "--rk-bg-deep",
  "--rk-page-lg-1",
  "--rk-page-lg-2",
  "--rk-surface",
  "--rk-surface-2",
  "--rk-surface-3",
  "--rk-ink",
  "--rk-muted",
  "--rk-muted-strong",
  "--rk-accent",
  "--rk-accent-2",
  "--rk-accent-ink",
  "--rk-line",
  "--rk-line-strong",
  "--rk-focus",
  "--rk-page-glow-1",
  "--rk-page-glow-2",
  "--rk-topbar-bg",
  "--rk-sidebar-bg",
  "--rk-shadow",
  "--rk-shadow-2",
  "--rk-album-fb-1",
  "--rk-album-fb-2",
  "--rk-art-empty-1",
  "--rk-art-empty-2",
  "--rk-badge-1",
  "--rk-badge-2",
  "--glass-1",
  "--glass-2",
] as const;

export function clearCustomThemeCss(root: HTMLElement = document.documentElement) {
  for (const name of CUSTOM_RK_VARS) root.style.removeProperty(name);
  root.style.removeProperty("color-scheme");
}

/** Map custom colors onto --rk-* tokens used by next UI. */
export function applyCustomThemeCss(
  theme: CustomThemeSettings,
  root: HTMLElement = document.documentElement,
) {
  const bg = theme.bg;
  const section = theme.section;
  const accent = theme.accent;
  const accent2 = theme.accent2;
  const light = relativeLuminance(section) > 0.45;
  root.style.colorScheme = light ? "light" : "dark";

  root.style.setProperty("--rk-bg", bg);
  root.style.setProperty("--rk-bg-deep", bg);
  root.style.setProperty(
    "--rk-page-lg-1",
    light ? mixHex(bg, "#0f172a", 0.045) : mixHex(bg, "#000000", 0.18),
  );
  root.style.setProperty("--rk-page-lg-2", bg);
  root.style.setProperty("--rk-accent", accent);
  root.style.setProperty("--rk-accent-2", accent2);
  root.style.setProperty("--rk-page-glow-1", rgbaFromHex(accent, 0.16));
  root.style.setProperty("--rk-page-glow-2", rgbaFromHex(accent2, 0.14));
  root.style.setProperty("--rk-album-fb-1", rgbaFromHex(accent, 0.28));
  root.style.setProperty("--rk-album-fb-2", rgbaFromHex(accent2, 0.18));
  root.style.setProperty("--rk-art-empty-1", rgbaFromHex(accent, 0.2));
  root.style.setProperty("--rk-art-empty-2", rgbaFromHex(accent2, 0.12));
  root.style.setProperty("--rk-badge-1", rgbaFromHex(accent, 0.26));
  root.style.setProperty("--rk-badge-2", rgbaFromHex(accent2, 0.18));
  root.style.setProperty(
    "--rk-sidebar-bg",
    `color-mix(in srgb, ${rgbaFromHex(section, 0.94)} 95%, ${bg} 5%)`,
  );

  if (light) {
    const ink = mixHex(section, "#0f172a", 0.78);
    root.style.setProperty("--rk-surface", rgbaFromHex(mixHex(bg, section, 0.52), 0.9));
    root.style.setProperty("--rk-surface-2", rgbaFromHex(section, 0.93));
    root.style.setProperty(
      "--rk-surface-3",
      rgbaFromHex(mixHex(section, accent2, 0.12), 0.96),
    );
    root.style.setProperty("--rk-ink", ink);
    root.style.setProperty("--rk-muted", mixHex(section, "#475569", 0.52));
    root.style.setProperty("--rk-muted-strong", mixHex(section, "#0f172a", 0.68));
    root.style.setProperty(
      "--rk-line",
      rgbaFromHex(mixHex(accent2, "#1e293b", 0.38), 0.18),
    );
    root.style.setProperty(
      "--rk-line-strong",
      rgbaFromHex(mixHex(accent2, "#0f172a", 0.45), 0.3),
    );
    root.style.setProperty(
      "--rk-focus",
      `color-mix(in srgb, ${accent2} 52%, #0f172a 32%)`,
    );
    root.style.setProperty(
      "--rk-accent-ink",
      relativeLuminance(accent) > 0.55
        ? mixHex(accent, "#0a0a0a", 0.9)
        : mixHex(accent, "#ffffff", 0.94),
    );
    root.style.setProperty(
      "--rk-topbar-bg",
      rgbaFromHex(mixHex(bg, "#ffffff", 0.14), 0.88),
    );
    root.style.setProperty("--rk-shadow", "0 4px 24px rgba(15, 23, 42, 0.08)");
    root.style.setProperty("--rk-shadow-2", "0 22px 48px rgba(15, 23, 42, 0.12)");
    root.style.setProperty(
      "--glass-1",
      rgbaFromHex(mixHex(section, "#ffffff", 0.22), 0.88),
    );
    root.style.setProperty(
      "--glass-2",
      rgbaFromHex(mixHex(bg, section, 0.22), 0.92),
    );
  } else {
    root.style.setProperty("--rk-surface", rgbaFromHex(mixHex(bg, section, 0.55), 0.88));
    root.style.setProperty("--rk-surface-2", rgbaFromHex(section, 0.94));
    root.style.setProperty(
      "--rk-surface-3",
      rgbaFromHex(mixHex(section, accent2, 0.1), 0.96),
    );
    root.style.setProperty("--rk-ink", mixHex(section, "#f8fafc", 0.92));
    root.style.setProperty("--rk-muted", mixHex(section, "#94a3b8", 0.55));
    root.style.setProperty("--rk-muted-strong", mixHex(section, "#e2e8f0", 0.72));
    root.style.setProperty("--rk-line", rgbaFromHex(mixHex(accent2, "#94a3b8", 0.4), 0.2));
    root.style.setProperty(
      "--rk-line-strong",
      rgbaFromHex(mixHex(accent2, "#cbd5e1", 0.35), 0.34),
    );
    root.style.setProperty(
      "--rk-focus",
      `color-mix(in srgb, ${accent2} 65%, white 20%)`,
    );
    root.style.setProperty(
      "--rk-accent-ink",
      relativeLuminance(accent) > 0.55
        ? mixHex(accent, "#0a0a0a", 0.9)
        : mixHex(accent, "#ffffff", 0.94),
    );
    root.style.setProperty("--rk-topbar-bg", rgbaFromHex(mixHex(bg, "#000000", 0.2), 0.82));
    root.style.setProperty(
      "--rk-shadow",
      "0 1px 0 rgba(0, 0, 0, 0.35), 0 2px 10px rgba(0, 0, 0, 0.22)",
    );
    root.style.setProperty("--rk-shadow-2", "0 4px 18px rgba(0, 0, 0, 0.28)");
    root.style.setProperty(
      "--glass-1",
      rgbaFromHex(mixHex(section, bg, 0.24), 0.9),
    );
    root.style.setProperty(
      "--glass-2",
      rgbaFromHex(mixHex(bg, section, 0.2), 0.94),
    );
  }
}
