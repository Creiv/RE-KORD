import { getSelectedAccountId } from "./account";
import {
  applyCustomThemeBgImageCssVars,
  clearCustomThemeBgImageCssVars,
} from "./customThemeBgFit";
import {
  applyAnimatedCustomThemeBg,
  clearAnimatedCustomThemeBg,
} from "./customThemeBgLayer";
import { customThemeBgImageUrl } from "./customThemeBgUrl";
import { platformCaps } from "./platformCaps";
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

export type AppLocale = "it" | "en" | "de";

/** Every UI language, in picker order. */
export const APP_LOCALES: readonly AppLocale[] = ["it", "en", "de"];

/**
 * Classic Listen visualizers (legacy VizMode minus DiscoWall). Kept as its own
 * list because the Settings picker keys its labels by it.
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

/** Listen visualizers drawn by a dedicated renderer rather than VizCanvasEngine. */
export const EXTRA_VISUALIZER_MODES = ["discowall"] as const;

/** Every mode a user can save (classic + DiscoWall). Plectr / Nebula are separate surfaces. */
export const ALL_VISUALIZER_MODES = [
  ...VISUALIZER_MODES,
  ...EXTRA_VISUALIZER_MODES,
] as const;

export type VisualizerMode = (typeof ALL_VISUALIZER_MODES)[number];

const VISUALIZER_MODE_SET = new Set<string>(ALL_VISUALIZER_MODES);

/** Map legacy / next aliases → canonical visualizer mode. */
export function normalizeVisualizerMode(raw: unknown): VisualizerMode {
  const v = String(raw ?? "").trim();
  if (v === "wave") return "osc";
  if (v === "smooth") return "oscSoft";
  // Separate surfaces, not Listen visualizers — fall back to bars.
  if (v === "plectr" || v === "nebula") return "bars";
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
  /** Personal moods: preferred key = rel_path (numeric id legacy only). */
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
  /** Fullscreen karaoke: the sung words, huge, behind the lyrics. */
  karaokeBackdrop: boolean;
  /** Per-account switches for the optional experiences (GitHub issue #100). */
  featureNebula: boolean;
  featureVisualizer: boolean;
  featurePlectr: boolean;
};

const LEGACY_GLOBAL_KEY = "rekord.next.userPrefs";

function prefsKey(accountId?: string | null): string {
  const id = (accountId || "").trim() || "default";
  return `rekord.next.userPrefs.${id}`;
}

function activeAccountId(): string {
  return (getSelectedAccountId() || "").trim() || "default";
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
    prefsCache.delete("default");
  } catch {
    /* ignore */
  }
}

const THEME_SET = new Set<string>(UI_THEMES);

/** Default glass opacity: 99% opaque, i.e. 1% transparency on the settings slider. */
export const DEFAULT_GLASS_OPACITY = 99;

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
  glassOpacity: DEFAULT_GLASS_OPACITY,
  locale: "it",
  visualizerMode: "bars",
  karaokeBackdrop: true,
  featureNebula: true,
  featureVisualizer: true,
  featurePlectr: true,
};

/** Clamp glass opacity percent (legacy normalizeGlassOpacity). */
export function normalizeGlassOpacity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GLASS_OPACITY;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function probeGlassBackdropWorks(): boolean {
  if (typeof document === "undefined" || typeof CSS === "undefined") return true;
  // The engine cannot blur at all (see lib/platformCaps.ts): opaque glass fallback.
  if (!platformCaps.backdropFilter) return false;
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
  return raw === "en" || raw === "de" ? raw : "it";
}

/** `de-AT`, `en_US`, `IT`… → a supported locale, or null. */
export function localeFromTag(tag: unknown): AppLocale | null {
  if (typeof tag !== "string") return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (APP_LOCALES as readonly string[]).includes(base) ? (base as AppLocale) : null;
}

/** First browser language we have a table for (fresh installs); Italian otherwise. */
export function browserLocale(
  languages: readonly (string | null | undefined)[] = navigatorLanguages(),
): AppLocale {
  for (const lang of languages) {
    const found = localeFromTag(lang);
    if (found) return found;
  }
  return "it";
}

function navigatorLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return [...(navigator.languages ?? []), navigator.language].filter(
    (l): l is string => typeof l === "string" && l.length > 0,
  );
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
  if (resolvedCustom?.accentWash === true) {
    root.dataset.accentWash = "1";
  } else {
    delete root.dataset.accentWash;
  }
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

/**
 * Parsed prefs per account, kept in memory: the blob can weigh hundreds of KB
 * (play counts, moods) and used to be re-parsed by every track row on every
 * player tick. Invalidated on save / patch (which also refill it) and on the
 * `storage` event (another tab rewrote the key).
 *
 * The collections inside a cached entry are frozen and shared by every
 * reader: copy before changing (`{ ...prefs.playCounts }`), then patch.
 */
const prefsCache = new Map<string, UserPrefs>();
/** Bumps on every change of any account's prefs (cheap staleness check). */
let prefsVersion = 0;

/*
 * Collections are frozen on our own plain copies, never on what the caller
 * handed in: a caller may pass live UI state (a Svelte `$state` array or
 * object), and freezing a `$state` proxy throws `state_descriptors_fixed`
 * (Object.freeze redefines every property as non-writable). Already-frozen
 * collections (the cached ones, reused by a patch) are kept as they are.
 */
function frozenList<T>(list: readonly T[] | null | undefined): readonly T[] {
  if (!Array.isArray(list)) return Object.freeze([]) as readonly T[];
  return Object.isFrozen(list) ? list : Object.freeze([...list]);
}

function frozenRecord<V>(rec: Record<string, V> | null | undefined): Record<string, V> {
  if (!rec || typeof rec !== "object") return Object.freeze({}) as Record<string, V>;
  return Object.isFrozen(rec) ? rec : Object.freeze({ ...rec });
}

function freezeCollections(p: UserPrefs): UserPrefs {
  p.playCounts = frozenRecord(p.playCounts);
  if (!Object.isFrozen(p.trackMoods)) {
    const moods: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(p.trackMoods ?? {})) {
      moods[key] = (Array.isArray(list) ? frozenList(list) : list) as string[];
    }
    p.trackMoods = Object.freeze(moods);
  }
  p.recentRelPaths = frozenList(p.recentRelPaths) as string[];
  p.recentTrackIds = frozenList(p.recentTrackIds) as number[];
  p.excludedRelPaths = frozenList(p.excludedRelPaths) as string[];
  p.excludedTrackIds = frozenList(p.excludedTrackIds) as number[];
  p.excludedAlbumIds = frozenList(p.excludedAlbumIds) as number[];
  return p;
}

function defaultPrefs(): UserPrefs {
  return {
    ...DEFAULTS,
    locale: browserLocale(),
    playCounts: {},
    recentRelPaths: [],
    recentTrackIds: [],
    trackMoods: {},
    excludedRelPaths: [],
    excludedTrackIds: [],
    excludedAlbumIds: [],
    customTheme: { ...DEFAULT_CUSTOM_THEME },
  };
}

function parsePrefs(raw: string | null): UserPrefs {
  if (!raw) return defaultPrefs();
  try {
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
      karaokeBackdrop: parsed.karaokeBackdrop !== false,
      featureNebula: parsed.featureNebula !== false,
      featureVisualizer: parsed.featureVisualizer !== false,
      featurePlectr: parsed.featurePlectr !== false,
    };
  } catch {
    return defaultPrefs();
  }
}

function cachedPrefs(id: string): UserPrefs {
  let entry = prefsCache.get(id);
  if (!entry) {
    migrateGlobalPrefsIfNeeded(id);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(prefsKey(id));
    } catch {
      raw = null;
    }
    entry = freezeCollections(parsePrefs(raw));
    prefsCache.set(id, entry);
  }
  return entry;
}

/**
 * Prefs of an account (default: the bound one). Cheap: served from memory.
 * The returned object is yours (top level), its collections are shared and
 * frozen — never mutate them in place.
 */
export function loadUserPrefs(accountId?: string | null): UserPrefs {
  const id = (accountId || "").trim() || activeAccountId();
  return { ...cachedPrefs(id) };
}

/** Play counts of the bound account (shared, read-only). */
export function getPlayCountsMap(accountId?: string | null): Readonly<Record<string, number>> {
  return cachedPrefs((accountId || "").trim() || activeAccountId()).playCounts;
}

/** Personal moods of the bound account (shared, read-only). */
export function getTrackMoodsMap(
  accountId?: string | null,
): Readonly<Record<string, readonly string[]>> {
  return cachedPrefs((accountId || "").trim() || activeAccountId()).trackMoods;
}

/** Recent paths of the bound account, newest first (shared, read-only). */
export function getRecentRelPaths(accountId?: string | null): readonly string[] {
  return cachedPrefs((accountId || "").trim() || activeAccountId()).recentRelPaths;
}

/** Changes on every prefs write of any account (not reactive; see prefsRevision). */
export function userPrefsVersion(): number {
  return prefsVersion;
}

/** Count of one track in a counts map (rel_path key, legacy numeric id fallback). */
export function playCountIn(
  counts: Readonly<Record<string, number>>,
  track: { id: number; rel_path: string },
): number {
  return counts[track.rel_path] ?? counts[String(track.id)] ?? 0;
}

export function saveUserPrefs(prefs: UserPrefs, accountId?: string | null) {
  const id = (accountId || "").trim() || activeAccountId();
  // Our own copy of the object fields that may be live UI state.
  const stored = freezeCollections({
    ...prefs,
    customTheme: { ...prefs.customTheme },
  });
  prefsCache.set(id, stored);
  prefsVersion += 1;
  try {
    localStorage.setItem(prefsKey(id), JSON.stringify(stored));
  } catch {
    /* quota / private mode: this tab keeps working from memory */
  }
}

/** Drop the in-memory copy (another writer changed the stored blob). */
export function invalidateUserPrefsCache(accountId?: string | null) {
  if (accountId == null) prefsCache.clear();
  else prefsCache.delete((accountId || "").trim() || "default");
  prefsVersion += 1;
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

const prefsPatchSubscribers = new Set<(patch: Partial<UserPrefs>) => void>();

/**
 * Like `subscribeUserPrefs`, but receives only the patched fields: lets views
 * re-derive on what actually changed (play counts, moods, exclusions) instead
 * of on every player tick.
 */
export function subscribeUserPrefsPatch(
  fn: (patch: Partial<UserPrefs>) => void,
): () => void {
  prefsPatchSubscribers.add(fn);
  return () => prefsPatchSubscribers.delete(fn);
}

/**
 * Kept for callers of the old API. It used to copy the `default` account's
 * prefs into an account seen for the first time, which handed every new
 * account the default's play counts and recents (and pushed them to the hub).
 * An account starts empty and takes its state from the hub.
 */
export function adoptPrefsForAccount(_accountId: string) {
  /* intentionally empty */
}

/**
 * Tell prefs subscribers that the whole blob changed under them (account
 * switch, another tab): every field counts as patched.
 */
export function notifyUserPrefsReplaced(accountId?: string | null) {
  const id = (accountId || "").trim() || activeAccountId();
  const prefs = loadUserPrefs(id);
  prefsVersion += 1;
  for (const fn of prefsSubscribers) fn(prefs);
  for (const fn of prefsPatchSubscribers) fn(prefs);
}

export function patchUserPrefs(
  patch: Partial<UserPrefs>,
  accountId?: string | null,
): UserPrefs {
  const id = (accountId || "").trim() || activeAccountId();
  const next: UserPrefs = { ...cachedPrefs(id), ...patch };
  if ("visualizerMode" in patch) {
    next.visualizerMode = normalizeVisualizerMode(next.visualizerMode);
  }
  saveUserPrefs(next, id);
  prefsChangeListener?.(next, patch, id);
  for (const fn of prefsSubscribers) fn(next);
  for (const fn of prefsPatchSubscribers) fn(patch);
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

/** Tracks that no longer exist on disk, by either key the prefs may use. */
export type GoneTracks = { relPaths: string[]; trackIds?: number[] };

/**
 * The fields to patch so nothing keeps pointing at deleted tracks: a play
 * count or a mood left behind would come back to life on a track that reuses
 * the same path later on.
 *
 * Pure on purpose (no storage): the caller decides when to persist.
 */
export function prefsWithoutTracks(
  prefs: UserPrefs,
  gone: GoneTracks,
): Partial<UserPrefs> {
  const paths = new Set(gone.relPaths.filter(Boolean));
  const ids = new Set((gone.trackIds ?? []).map((id) => String(id)));
  if (!paths.size && !ids.size) return {};
  const keyIsGone = (key: string) => paths.has(key) || ids.has(key);

  const playCounts: Record<string, number> = {};
  for (const [key, n] of Object.entries(prefs.playCounts)) {
    if (!keyIsGone(key)) playCounts[key] = n;
  }
  const trackMoods: Record<string, string[]> = {};
  for (const [key, moods] of Object.entries(prefs.trackMoods)) {
    if (!keyIsGone(key)) trackMoods[key] = moods;
  }
  return {
    excludedRelPaths: prefs.excludedRelPaths.filter((p) => !paths.has(p)),
    excludedTrackIds: prefs.excludedTrackIds.filter((id) => !ids.has(String(id))),
    recentRelPaths: prefs.recentRelPaths.filter((p) => !paths.has(p)),
    recentTrackIds: prefs.recentTrackIds.filter((id) => !ids.has(String(id))),
    playCounts,
    trackMoods,
  };
}

/** Same, applied and saved. */
export function forgetTracksInPrefs(gone: GoneTracks): UserPrefs {
  const patch = prefsWithoutTracks(loadUserPrefs(), gone);
  return patchUserPrefs(patch);
}

// Another tab rewrote some prefs: our parsed copy is stale.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.storageArea && typeof localStorage !== "undefined" && event.storageArea !== localStorage) return;
    if (event.key == null) {
      invalidateUserPrefsCache(null);
      return;
    }
    if (event.key.startsWith("rekord.next.userPrefs.")) {
      invalidateUserPrefsCache(event.key.slice("rekord.next.userPrefs.".length));
    }
  });
}
