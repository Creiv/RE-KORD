/**
 * Import stato utente dalla RE-KORD React legacy (UserStateV1 / user-state.json).
 * Preferenze → localStorage; favoriti/playlist → API hub (resolve per rel_path).
 */

import { api, type Album, type Track } from "./api";
import { writeStreakState } from "./achievements";
import { player } from "./player";
import {
  normalizeCustomTheme,
  type CustomThemeSettings,
} from "./themeCatalog";
import {
  applyTheme,
  loadUserPrefs,
  normalizeTheme,
  normalizeVisualizerMode,
  patchUserPrefs,
  type CrossfadeSec,
  type UiTheme,
  type UserPrefs,
} from "./userPrefs";

export type LegacyImportReport = {
  favoritesOk: number;
  favoritesSkip: number;
  playlistOk: number;
  playlistTracksOk: number;
  playlistTracksSkip: number;
  playCounts: number;
  recent: number;
  moods: number;
  excludedTracks: number;
  excludedAlbums: number;
  theme: UiTheme;
  streak: boolean;
  warnings: string[];
};

type LegacyEnrichedTrack = {
  relPath?: string;
  rel_path?: string;
  title?: string;
};

type LegacyPlaylistTrack = {
  relPath?: string;
  rel_path?: string;
  title?: string;
  artist?: string;
  album?: string;
};

type LegacyPlaylist = {
  id?: string;
  name?: string;
  tracks?: LegacyPlaylistTrack[];
};

type LegacySettings = {
  theme?: string;
  restoreSession?: boolean;
  audioCrossfadeSec?: number;
  vizMode?: string;
  visualizerMode?: string;
  customTheme?: Partial<CustomThemeSettings>;
  glassSurfaces?: boolean;
  glassOpacity?: number;
};

/** Subset of old UserStateV1 we understand. */
export type LegacyUserState = {
  version?: number;
  favorites?: string[];
  recent?: LegacyEnrichedTrack[];
  trackPlayCounts?: Record<string, number>;
  playlists?: LegacyPlaylist[];
  settings?: LegacySettings;
  shuffleExcludedAlbumIds?: string[];
  shuffleExcludedTrackRelPaths?: string[];
  trackMoods?: Record<string, string[]>;
};

type LegacyImportEnvelope = {
  kind?: string;
  userState?: LegacyUserState;
  streak?: { count?: number; lastDate?: string };
  state?: LegacyUserState;
};

export type LegacyImportProgress = {
  phase: string;
  done: number;
  total: number;
};

function normalizeRelPath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  // Loose-folder rename used in legacy migrations.
  s = s.replace(/(^|\/)Tracce(\/|$)/gi, "$1Tracks$2");
  return s;
}

function pathAliases(p: string): string[] {
  const n = normalizeRelPath(p);
  const out = new Set<string>([n, p.trim().replace(/\\/g, "/")]);
  if (n.includes("/Tracks/")) out.add(n.replace("/Tracks/", "/Tracce/"));
  if (n.includes("/Tracce/")) out.add(n.replace("/Tracce/", "/Tracks/"));
  return [...out];
}

function buildTrackIndex(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) {
    for (const a of pathAliases(t.rel_path)) {
      if (!map.has(a)) map.set(a, t);
    }
  }
  return map;
}

function resolveTrack(
  index: Map<string, Track>,
  rel: string | undefined | null,
): Track | null {
  if (!rel) return null;
  for (const a of pathAliases(rel)) {
    const hit = index.get(a);
    if (hit) return hit;
  }
  return null;
}

function mapTheme(theme: string | undefined): UiTheme {
  if (!theme) return "midnight";
  const t = theme.toLowerCase().trim();
  const exact = normalizeTheme(t);
  if (exact !== "midnight" || t === "midnight") return exact;
  // Fuzzy fallback for odd legacy labels / custom → midnight
  if (t.includes("ember")) return "ember";
  if (t.includes("sunset")) return "sunset";
  if (t.includes("aurora")) return "aurora";
  if (t.includes("forest")) return "forest";
  if (t.includes("neon")) return "neon";
  if (t.includes("ocean")) return "ocean";
  if (t.includes("rose")) return "rose";
  if (t.includes("prism")) return "prism";
  if (t.includes("aubergine") && t.includes("light")) return "aubergine-light";
  if (t.includes("tangerine") && t.includes("light")) return "tangerine-light";
  if (t.includes("carmine") && t.includes("light")) return "carmine-light";
  if (t.includes("slate") && t.includes("light")) return "slate-light";
  if (t.includes("aubergine")) return "aubergine";
  if (t.includes("tangerine")) return "tangerine";
  if (t.includes("carmine")) return "carmine";
  if (t.includes("slate")) return "slate";
  if (t === "custom" || t.includes("custom") || t.includes("personalizz"))
    return "custom";
  return "midnight";
}

function mapCrossfade(v: unknown): CrossfadeSec {
  if (v === 0 || v === 3 || v === 5) return v;
  if (v === 4 || v === 6) return 5;
  return 3;
}

function albumKeyFromLegacy(id: string): string {
  // Legacy album.id = "artist::folder" → next folder_key = "artist/folder"
  return id.includes("::") ? id.replace("::", "/") : id;
}

function isLegacyUserState(v: unknown): v is LegacyUserState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.favorites) ||
    Array.isArray(o.recent) ||
    Array.isArray(o.playlists) ||
    (o.trackPlayCounts != null && typeof o.trackPlayCounts === "object") ||
    (o.settings != null && typeof o.settings === "object")
  );
}

type FileWithPath = File & { webkitRelativePath?: string };

function fileRelPath(f: File): string {
  return ((f as FileWithPath).webkitRelativePath || f.name).replace(/\\/g, "/");
}

function isUserStateFileName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return (
    base === "user-state.json" ||
    base === "user-state.v1.json" ||
    base.endsWith(".kord-user-state.v1.json") ||
    base.endsWith(".rekord-user-state.v1.json")
  );
}

/**
 * From a directory picker selection (`.kord` or music root containing it),
 * pick the best `user-state.json` (default account if accounts.json present).
 */
export async function pickUserStateFromKordFolder(
  files: FileList | File[],
): Promise<{ state: LegacyUserState; sourcePath: string }> {
  const list = [...files];
  if (!list.length) {
    throw new Error("Cartella vuota — seleziona la cartella .kord della libreria legacy.");
  }

  const stateFiles = list.filter((f) => isUserStateFileName(fileRelPath(f)));
  if (!stateFiles.length) {
    throw new Error(
      "Nessun user-state.json trovato. Seleziona la cartella .kord (o la Music che la contiene).",
    );
  }

  // Prefer account dirs: `<id>_info/user-state.json`
  const accountStates = stateFiles.filter((f) =>
    /(?:^|\/)[^/]+_info\/user-state\.json$/i.test(fileRelPath(f)),
  );
  const candidates = accountStates.length ? accountStates : stateFiles;

  let preferredId: string | null = null;
  const accountsFile = list.find((f) => {
    const p = fileRelPath(f);
    return (
      p.endsWith("/global_info/accounts.json") ||
      p === "global_info/accounts.json" ||
      p.endsWith("/.kord/global_info/accounts.json")
    );
  });
  if (accountsFile) {
    try {
      const acc = JSON.parse(await accountsFile.text()) as {
        defaultAccountId?: string;
      };
      if (typeof acc.defaultAccountId === "string" && acc.defaultAccountId) {
        preferredId = acc.defaultAccountId;
      }
    } catch {
      /* ignore */
    }
  }

  let chosen = candidates[0]!;
  if (preferredId) {
    const hit = candidates.find((f) =>
      fileRelPath(f).includes(`/${preferredId}_info/`),
    );
    if (hit) chosen = hit;
  } else {
    // Largest file ≈ richest state
    chosen = candidates.reduce((a, b) => (b.size > a.size ? b : a), candidates[0]!);
  }

  const raw = await chosen.text();
  const { state } = parseLegacyImportJson(raw);
  return { state, sourcePath: fileRelPath(chosen) };
}

/** Parse uploaded JSON (raw UserStateV1 or thin envelope). */
export function parseLegacyImportJson(raw: string): {
  state: LegacyUserState;
  streak?: { count: number; lastDate: string };
} {
  const data = JSON.parse(raw) as LegacyImportEnvelope | LegacyUserState;
  if (isLegacyUserState(data)) {
    return { state: data };
  }
  const env = data as LegacyImportEnvelope;
  const state = env.userState ?? env.state;
  if (!state || !isLegacyUserState(state)) {
    throw new Error(
      "JSON non riconosciuto: seleziona un user-state.json della RE-KORD legacy (campo favorites/playlists/settings).",
    );
  }
  let streak: { count: number; lastDate: string } | undefined;
  if (env.streak && typeof env.streak.count === "number") {
    streak = {
      count: Math.max(0, Math.floor(env.streak.count)),
      lastDate: typeof env.streak.lastDate === "string" ? env.streak.lastDate : "",
    };
  }
  return { state, streak };
}

export async function applyLegacyUserState(
  state: LegacyUserState,
  opts: {
    catalog: Track[];
    albums: Album[];
    existingFavoriteIds: Set<number>;
    existingPlaylists: { id: string; name: string }[];
    streak?: { count: number; lastDate: string };
    onProgress?: (p: LegacyImportProgress) => void;
  },
): Promise<LegacyImportReport> {
  const warnings: string[] = [];
  const index = buildTrackIndex(opts.catalog);
  const report: LegacyImportReport = {
    favoritesOk: 0,
    favoritesSkip: 0,
    playlistOk: 0,
    playlistTracksOk: 0,
    playlistTracksSkip: 0,
    playCounts: 0,
    recent: 0,
    moods: 0,
    excludedTracks: 0,
    excludedAlbums: 0,
    theme: "midnight",
    streak: false,
    warnings,
  };

  const prefs = loadUserPrefs();
  const settings = state.settings ?? {};

  // —— Preferences (client) ——
  report.theme = mapTheme(settings.theme);
  const crossfade = mapCrossfade(settings.audioCrossfadeSec);
  const restoreSession = settings.restoreSession !== false;

  const playCounts: Record<string, number> = { ...prefs.playCounts };
  for (const [rawPath, n] of Object.entries(state.trackPlayCounts ?? {})) {
    if (typeof n !== "number" || n <= 0) continue;
    const path = normalizeRelPath(rawPath);
    const prev = playCounts[path] ?? 0;
    playCounts[path] = Math.max(prev, Math.floor(n));
    report.playCounts += 1;
  }

  const recentFromState = (state.recent ?? [])
    .map((t) => normalizeRelPath(t.relPath || t.rel_path || ""))
    .filter(Boolean);
  const recentRelPaths = [
    ...recentFromState,
    ...prefs.recentRelPaths.filter((p) => !recentFromState.includes(p)),
  ].slice(0, 100);
  report.recent = recentFromState.length;

  const excludedRelPaths = new Set(prefs.excludedRelPaths);
  for (const p of state.shuffleExcludedTrackRelPaths ?? []) {
    excludedRelPaths.add(normalizeRelPath(p));
  }
  report.excludedTracks = (state.shuffleExcludedTrackRelPaths ?? []).length;

  const excludedAlbumIds = new Set(prefs.excludedAlbumIds);
  const albumByFolder = new Map(
    opts.albums.map((a) => [normalizeRelPath(a.folder_key), a.id]),
  );
  for (const legacyId of state.shuffleExcludedAlbumIds ?? []) {
    const key = normalizeRelPath(albumKeyFromLegacy(legacyId));
    const id = albumByFolder.get(key);
    if (id != null) {
      excludedAlbumIds.add(id);
      report.excludedAlbums += 1;
    } else {
      warnings.push(`Album escluso non trovato: ${legacyId}`);
    }
  }

  const trackMoods: Record<string, string[]> = { ...prefs.trackMoods };
  for (const [rawPath, moods] of Object.entries(state.trackMoods ?? {})) {
    if (!Array.isArray(moods) || !moods.length) continue;
    const path = normalizeRelPath(rawPath);
    trackMoods[path] = moods.filter((m) => typeof m === "string").slice(0, 3);
    report.moods += 1;
  }

  const customTheme: CustomThemeSettings = normalizeCustomTheme(
    settings.customTheme && typeof settings.customTheme === "object"
      ? (settings.customTheme as Partial<CustomThemeSettings>)
      : undefined,
  );

  const glassSurfaces = settings.glassSurfaces === true;
  const glassOpacity =
    settings.glassOpacity != null && Number.isFinite(Number(settings.glassOpacity))
      ? Math.min(100, Math.max(0, Math.round(Number(settings.glassOpacity))))
      : prefs.glassOpacity;

  const vizMode = normalizeVisualizerMode(
    settings.vizMode ?? settings.visualizerMode,
  );

  const nextPrefs: Partial<UserPrefs> = {
    theme: report.theme,
    customTheme,
    glassSurfaces,
    glassOpacity,
    crossfadeSec: crossfade,
    restoreSession,
    playCounts,
    recentRelPaths,
    recentTrackIds: [],
    excludedRelPaths: [...excludedRelPaths],
    excludedTrackIds: [],
    excludedAlbumIds: [...excludedAlbumIds],
    trackMoods,
    visualizerMode: vizMode,
  };
  patchUserPrefs(nextPrefs);
  applyTheme(report.theme, customTheme, { glassSurfaces, glassOpacity });
  player.setCrossfadeSec(crossfade);
  player.reloadExclusionsFromPrefs();

  if (opts.streak && opts.streak.count > 0) {
    writeStreakState(opts.streak);
    report.streak = true;
  }

  // —— Favorites (API) ——
  const favPaths = state.favorites ?? [];
  opts.onProgress?.({ phase: "Preferiti", done: 0, total: favPaths.length });
  for (let i = 0; i < favPaths.length; i++) {
    const track = resolveTrack(index, favPaths[i]);
    if (!track) {
      report.favoritesSkip += 1;
      warnings.push(`Preferito assente in libreria: ${favPaths[i]}`);
    } else if (opts.existingFavoriteIds.has(track.id)) {
      report.favoritesSkip += 1;
    } else {
      try {
        await api.addFavorite(track.id);
        opts.existingFavoriteIds.add(track.id);
        report.favoritesOk += 1;
      } catch (e) {
        report.favoritesSkip += 1;
        warnings.push(
          `Preferito fallito (${favPaths[i]}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    opts.onProgress?.({ phase: "Preferiti", done: i + 1, total: favPaths.length });
  }

  // —— Playlists (API) ——
  const playlists = state.playlists ?? [];
  opts.onProgress?.({ phase: "Playlist", done: 0, total: playlists.length });
  for (let pi = 0; pi < playlists.length; pi++) {
    const pl = playlists[pi]!;
    const name = (pl.name || "Playlist importata").trim() || "Playlist importata";
    let playlistId =
      opts.existingPlaylists.find((p) => p.name === name)?.id ?? null;
    if (!playlistId) {
      try {
        const created = await api.createPlaylist(name);
        playlistId = created.id;
        opts.existingPlaylists.push({ id: created.id, name: created.name });
        report.playlistOk += 1;
      } catch (e) {
        warnings.push(
          `Playlist «${name}» non creata: ${e instanceof Error ? e.message : String(e)}`,
        );
        opts.onProgress?.({
          phase: "Playlist",
          done: pi + 1,
          total: playlists.length,
        });
        continue;
      }
    } else {
      report.playlistOk += 1;
    }

    for (const row of pl.tracks ?? []) {
      const track = resolveTrack(index, row.relPath || row.rel_path);
      if (!track) {
        report.playlistTracksSkip += 1;
        continue;
      }
      try {
        await api.addToPlaylist(playlistId, track.id);
        report.playlistTracksOk += 1;
      } catch {
        // likely already in playlist
        report.playlistTracksSkip += 1;
      }
    }
    opts.onProgress?.({
      phase: "Playlist",
      done: pi + 1,
      total: playlists.length,
    });
  }

  if (!opts.catalog.length) {
    warnings.push(
      "Catalogo libreria vuoto: favoriti/playlist non risolti. Esegui uno scan e ripeti l’import.",
    );
  }

  return report;
}
