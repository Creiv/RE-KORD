export type CrossfadeSec = 0 | 3 | 5;

/** Named UI themes (parity with old catalog minus `custom` / glass). Midnight = :root. */
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
] as const;

export type UiTheme = (typeof UI_THEMES)[number];

export type AppLocale = "it" | "en";

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
  locale: AppLocale;
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
  locale: "it",
};

export function normalizeTheme(raw: unknown): UiTheme {
  if (typeof raw === "string" && THEME_SET.has(raw)) return raw as UiTheme;
  return "midnight";
}

export function normalizeLocale(raw: unknown): AppLocale {
  return raw === "en" ? "en" : "it";
}

export function applyTheme(theme: UiTheme) {
  const root = document.documentElement;
  const t = normalizeTheme(theme);
  if (t === "midnight") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
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
      locale: normalizeLocale(parsed.locale),
    };
  } catch {
    return {
      ...DEFAULTS,
      playCounts: {},
      recentRelPaths: [],
      recentTrackIds: [],
      trackMoods: {},
      excludedRelPaths: [],
    };
  }
}

export function saveUserPrefs(prefs: UserPrefs, accountId?: string | null) {
  const id = (accountId || "").trim() || activeAccountId();
  localStorage.setItem(prefsKey(id), JSON.stringify(prefs));
}

export function patchUserPrefs(
  patch: Partial<UserPrefs>,
  accountId?: string | null,
): UserPrefs {
  const next = { ...loadUserPrefs(accountId), ...patch };
  saveUserPrefs(next, accountId);
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
