import {
  applyCustomThemeBgImageCssVars,
  clearCustomThemeBgImageCssVars,
} from "./customThemeBgFit";
import {
  applyAnimatedCustomThemeBg,
  clearAnimatedCustomThemeBg,
} from "./customThemeBgLayer";
import { customThemeBgImageUrl } from "./customThemeBgUrl";
import {
  applyCustomThemeCss,
  clearCustomThemeCss,
  DEFAULT_CUSTOM_THEME,
  normalizeCustomTheme,
  type CustomThemeSettings,
} from "./themeCatalog";

export type CrossfadeSec = 0 | 3 | 5;
export type { CustomThemeSettings };

/** Named UI themes (parity with legacy catalog, including custom). Midnight = :root. */
export const UI_THEMES = [
  "midnight",
  "sunset",
  "aurora",
  "ember",
  "forest",
  "neon",
  "ocean",
  "rose",
  "slate",
  "aubergine",
  "tangerine",
  "carmine",
  "prism",
  "slate-light",
  "aubergine-light",
  "tangerine-light",
  "carmine-light",
  "custom",
] as const;

export type UiTheme = (typeof UI_THEMES)[number];

export type AppLocale = "it" | "en";

/**
 * Classic Listen visualizers (legacy VizMode minus DiscoWall).
 * Plectr / Nebula are separate surfaces, not prefs here.
 */
export const VISUALIZER_MODES = [
  "bars",
  "mirror",
  "osc",
  "oscSoft",
  "hmb",
  "signals",
  "karaoke",
] as const;

export type VisualizerMode = (typeof VISUALIZER_MODES)[number];

const VISUALIZER_MODE_SET = new Set<string>(VISUALIZER_MODES);

/** Map legacy / next aliases → canonical visualizer mode. */
export function normalizeVisualizerMode(raw: unknown): VisualizerMode {
  const v = String(raw ?? "").trim();
  if (v === "wave") return "osc";
  if (v === "smooth") return "oscSoft";
  // Excluded surfaces — fall back to bars
  if (v === "discowall" || v === "plectr" || v === "nebula") return "bars";
  if (VISUALIZER_MODE_SET.has(v)) return v as VisualizerMode;
  return "bars";
}

export type UserPrefs = {
  crossfadeSec: CrossfadeSec;
  /** Stable keys (rel_path). Survives library re-scan / id churn. */
  excludedRelPaths: string[];
  /** @deprecated migrated → excludedRelPaths */
  excludedTrackIds: number[];
  excludedAlbumIds: number[];
  /** Play counts keyed by rel_path (legacy id keys migrated when catalog loads). */
  playCounts: Record<string, number>;
  /** Most recent first, keyed by rel_path. */
  recentRelPaths: string[];
  /** @deprecated migrated → recentRelPaths */
  recentTrackIds: number[];
  /** Mood salvati lato client: chiave = track id stringa o rel_path. */
  trackMoods: Record<string, string[]>;
  /**
   * Legacy import compat only. Session restore is always on in next;
   * this flag is never used to disable persistence/restore.
   */
  restoreSession: boolean;
  theme: UiTheme;
  customTheme: CustomThemeSettings;
  /** Semi-transparent frosted surfaces (legacy glassSurfaces). */
  glassSurfaces: boolean;
  /** Glass panel opacity 0–100 (legacy default 62). */
  glassOpacity: number;
  locale: AppLocale;
  visualizerMode: VisualizerMode;
};

const LEGACY_GLOBAL_KEY = "rekord.next.userPrefs";

function prefsKey(accountId?: string | null): string {
  const id = (accountId || "").trim() || "default";
  return `rekord.next.userPrefs.${id}`;
}

function activeAccountId(): string {
  try {
    return (
      localStorage.getItem("rekord.next.sessionAccountId") ||
      localStorage.getItem("rekord-session-account-id") ||
      "default"
    );
  } catch {
    return "default";
  }
}

/** Migrate pre-multi-account prefs blob onto the default account key (once). */
function migrateGlobalPrefsIfNeeded(accountId: string) {
  if (accountId !== "default") return;
  try {
    if (localStorage.getItem(prefsKey("default"))) return;
    const legacy = localStorage.getItem(LEGACY_GLOBAL_KEY);
    if (!legacy) return;
    localStorage.setItem(prefsKey("default"), legacy);
    localStorage.removeItem(LEGACY_GLOBAL_KEY);
  } catch {
    /* ignore */
  }
}

const THEME_SET = new Set<string>(UI_THEMES);

const DEFAULTS: UserPrefs = {
  crossfadeSec: 3,
  excludedRelPaths: [],
  excludedTrackIds: [],
  excludedAlbumIds: [],
  playCounts: {},
  recentRelPaths: [],
  recentTrackIds: [],
  trackMoods: {},
  restoreSession: true,
  theme: "midnight",
  customTheme: { ...DEFAULT_CUSTOM_THEME },
  glassSurfaces: false,
  glassOpacity: 62,
  locale: "it",
  visualizerMode: "bars",
};

/** Clamp glass opacity percent (legacy normalizeGlassOpacity). */
export function normalizeGlassOpacity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 62;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function probeGlassBackdropWorks(): boolean {
  if (typeof document === "undefined" || typeof CSS === "undefined") return true;
  const supportsBlur =
    CSS.supports("backdrop-filter", "blur(2px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(2px)");
  if (!supportsBlur) return false;
  try {
    if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) {
      return false;
    }
  } catch {
    /* ignore */
  }
  return true;
}

/** Apply data-glass-surfaces + CSS vars on <html> (legacy syncGlassSurfaceDom). */
export function syncGlassSurfaceDom(
  root: HTMLElement = document.documentElement,
  settings?: { glassSurfaces?: boolean; glassOpacity?: number },
): void {
  const src = settings ?? loadUserPrefs();
  if (!src.glassSurfaces) {
    delete root.dataset.glassSurfaces;
    delete root.dataset.glassBackdrop;
    root.style.removeProperty("--glass-user-opacity");
    return;
  }
  root.dataset.glassSurfaces = "1";
  const opacity = normalizeGlassOpacity(src.glassOpacity);
  root.style.setProperty("--glass-user-opacity", String(opacity / 100));
  root.dataset.glassBackdrop = probeGlassBackdropWorks() ? "1" : "0";
}

export function normalizeTheme(raw: unknown): UiTheme {
  if (typeof raw === "string" && THEME_SET.has(raw)) return raw as UiTheme;
  return "midnight";
}

export function normalizeLocale(raw: unknown): AppLocale {
  return raw === "en" ? "en" : "it";
}

function applyCustomThemeBackground(
  theme: CustomThemeSettings | null | undefined,
  activeThemeIsCustom: boolean,
  root: HTMLElement = document.documentElement,
) {
  const custom = theme ? normalizeCustomTheme(theme) : null;
  const useBgImage =
    activeThemeIsCustom &&
    custom?.bgMode === "image" &&
    Boolean(custom.bgImage);
  if (useBgImage && custom) {
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
}

export function applyTheme(
  theme: UiTheme,
  customTheme?: CustomThemeSettings | null,
  glass?: { glassSurfaces?: boolean; glassOpacity?: number } | null,
) {
  const root = document.documentElement;
  const prefs = loadUserPrefs();
  const t = normalizeTheme(theme);
  clearCustomThemeCss(root);
  if (t === "midnight") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  const resolvedCustom =
    t === "custom"
      ? normalizeCustomTheme(customTheme ?? prefs.customTheme)
      : null;
  if (resolvedCustom) applyCustomThemeCss(resolvedCustom, root);
  applyCustomThemeBackground(resolvedCustom, t === "custom", root);
  syncGlassSurfaceDom(root, {
    glassSurfaces: glass?.glassSurfaces ?? prefs.glassSurfaces,
    glassOpacity: glass?.glassOpacity ?? prefs.glassOpacity,
  });
}

function normalizeCrossfade(v: unknown): CrossfadeSec {
  if (v === 3 || v === 5 || v === 0) return v;
  if (v === 4 || v === 6) return 5;
  return 3;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function asNumberList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

export function loadUserPrefs(accountId?: string | null): UserPrefs {
  const id = (accountId || "").trim() || activeAccountId();
  migrateGlobalPrefsIfNeeded(id);
  try {
    const raw = localStorage.getItem(prefsKey(id));
    if (!raw) return { ...DEFAULTS, playCounts: {} };
    const parsed = JSON.parse(raw) as Partial<UserPrefs>;
    return {
      crossfadeSec: normalizeCrossfade(parsed.crossfadeSec),
      excludedRelPaths: asStringList(parsed.excludedRelPaths),
      excludedTrackIds: asNumberList(parsed.excludedTrackIds),
      excludedAlbumIds: asNumberList(parsed.excludedAlbumIds),
      playCounts:
        parsed.playCounts && typeof parsed.playCounts === "object"
          ? parsed.playCounts
          : {},
      recentRelPaths: asStringList(parsed.recentRelPaths).slice(0, 100),
      recentTrackIds: asNumberList(parsed.recentTrackIds).slice(0, 100),
      trackMoods:
        parsed.trackMoods && typeof parsed.trackMoods === "object"
          ? Object.fromEntries(
              Object.entries(parsed.trackMoods).filter(
                ([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"),
              ),
            )
          : {},
      restoreSession: parsed.restoreSession !== false,
      theme: normalizeTheme(parsed.theme),
      customTheme: normalizeCustomTheme(
        parsed.customTheme && typeof parsed.customTheme === "object"
          ? (parsed.customTheme as Partial<CustomThemeSettings>)
          : undefined,
      ),
      glassSurfaces: parsed.glassSurfaces === true,
      glassOpacity: normalizeGlassOpacity(parsed.glassOpacity),
      locale: normalizeLocale(parsed.locale),
      visualizerMode: normalizeVisualizerMode(
        parsed.visualizerMode ??
          (parsed as { vizMode?: unknown }).vizMode,
      ),
    };
  } catch {
    return {
      ...DEFAULTS,
      playCounts: {},
      recentRelPaths: [],
      recentTrackIds: [],
      trackMoods: {},
      excludedRelPaths: [],
      customTheme: { ...DEFAULT_CUSTOM_THEME },
    };
  }
}

export function saveUserPrefs(prefs: UserPrefs, accountId?: string | null) {
  const id = (accountId || "").trim() || activeAccountId();
  localStorage.setItem(prefsKey(id), JSON.stringify(prefs));
}

type PrefsChangeListener = (
  prefs: UserPrefs,
  patch: Partial<UserPrefs>,
  accountId: string,
) => void;

let prefsChangeListener: PrefsChangeListener | null = null;
const prefsSubscribers = new Set<(prefs: UserPrefs) => void>();

/** Session registers this to debounce-push user-state after local edits. */
export function setUserPrefsChangeListener(fn: PrefsChangeListener | null) {
  prefsChangeListener = fn;
}

/** UI components subscribe for live prefs (e.g. visualizer mode). */
export function subscribeUserPrefs(fn: (prefs: UserPrefs) => void): () => void {
  prefsSubscribers.add(fn);
  return () => prefsSubscribers.delete(fn);
}

/**
 * When the real account id is first assigned, copy prefs that were saved under
 * `default` (or the legacy global key) so UI choices aren't orphaned.
 */
export function adoptPrefsForAccount(accountId: string) {
  const id = (accountId || "").trim();
  if (!id || id === "default") return;
  try {
    if (localStorage.getItem(prefsKey(id))) return;
    const fromDefault = localStorage.getItem(prefsKey("default"));
    if (fromDefault) {
      localStorage.setItem(prefsKey(id), fromDefault);
      return;
    }
    const legacy = localStorage.getItem(LEGACY_GLOBAL_KEY);
    if (legacy) localStorage.setItem(prefsKey(id), legacy);
  } catch {
    /* ignore */
  }
}

export function patchUserPrefs(
  patch: Partial<UserPrefs>,
  accountId?: string | null,
): UserPrefs {
  const id = (accountId || "").trim() || activeAccountId();
  const next = { ...loadUserPrefs(id), ...patch };
  if ("visualizerMode" in patch) {
    next.visualizerMode = normalizeVisualizerMode(next.visualizerMode);
  }
  saveUserPrefs(next, id);
  prefsChangeListener?.(next, patch, id);
  for (const fn of prefsSubscribers) fn(next);
  return next;
}

type PathTrack = { id: number; rel_path: string };

/**
 * Remap legacy numeric ids → rel_path after catalog load so prefs survive
 * `clear_catalog()` re-scans that reassign SQLite ids.
 */
export function migratePrefsToRelPaths(tracks: PathTrack[]): UserPrefs {
  const prefs = loadUserPrefs();
  const byId = new Map(tracks.map((t) => [t.id, t.rel_path]));

  let changed = false;

  // recent: ids → paths
  if (prefs.recentTrackIds.length && !prefs.recentRelPaths.length) {
    const paths = prefs.recentTrackIds
      .map((id) => byId.get(id))
      .filter((p): p is string => Boolean(p));
    if (paths.length) {
      prefs.recentRelPaths = paths.slice(0, 100);
      prefs.recentTrackIds = [];
      changed = true;
    }
  } else if (prefs.recentTrackIds.length) {
    const merged = [
      ...prefs.recentRelPaths,
      ...prefs.recentTrackIds
        .map((id) => byId.get(id))
        .filter((p): p is string => Boolean(p)),
    ];
    const dedup: string[] = [];
    for (const p of merged) {
      if (!dedup.includes(p)) dedup.push(p);
    }
    prefs.recentRelPaths = dedup.slice(0, 100);
    prefs.recentTrackIds = [];
    changed = true;
  }

  // exclude tracks: ids → paths
  if (prefs.excludedTrackIds.length) {
    const fromIds = prefs.excludedTrackIds
      .map((id) => byId.get(id))
      .filter((p): p is string => Boolean(p));
    const set = new Set([...prefs.excludedRelPaths, ...fromIds]);
    prefs.excludedRelPaths = [...set];
    prefs.excludedTrackIds = [];
    changed = true;
  }

  // playCounts: numeric-string keys → rel_path
  const nextCounts: Record<string, number> = { ...prefs.playCounts };
  for (const [key, n] of Object.entries(prefs.playCounts)) {
    if (!/^\d+$/.test(key)) continue;
    const path = byId.get(Number(key));
    if (!path) continue;
    nextCounts[path] = (nextCounts[path] ?? 0) + (typeof n === "number" ? n : 0);
    delete nextCounts[key];
    changed = true;
  }
  prefs.playCounts = nextCounts;

  if (changed) saveUserPrefs(prefs);
  return prefs;
}

export function playCountFor(
  prefs: UserPrefs,
  track: { id: number; rel_path: string },
): number {
  return prefs.playCounts[track.rel_path] ?? prefs.playCounts[String(track.id)] ?? 0;
}
