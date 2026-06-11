/**
 * Helper puri e piccoli componenti SVG dello Studio (ToolsView).
 * Estratti da ToolsView.tsx (Fase 6): nessuno stato, nessun hook.
 */
import {
  REKORD_STUDIO_PANE,
  type StudioPaneId,
} from "../context/StudioNavigationContext";
import type { YoutubeExploreResult } from "../lib/api";
import type {
  CatalogArtistEntry,
  LibTrack,
  LibraryIndex,
  LibraryResponse,
  LibrarySelectionV1,
} from "../types";
import {
  buildStudioDownloadConfirm,
  joinMusicDestRelPath,
  normalizeDownloadDestPath,
  type StudioDownloadScope,
} from "../lib/studioDownloadDest";

export function sourceLabel(s: string | undefined): string {
  if (s === "itunes") return "iTunes";
  if (s === "deezer") return "Deezer";
  if (s === "musicbrainz") return "MusicBrainz";
  if (s === "theaudiodb") return "TheAudioDB";
  if (s === "coverart") return "CAA / MB";
  return s || "—";
}

export function extLinkLabel(url: string, openWord: string): string {
  try {
    const h = new URL(url).hostname;
    if (h.includes("apple.com")) return "iTunes / Apple";
    if (h.includes("deezer.com")) return "Deezer";
    if (h.includes("musicbrainz.org")) return "MusicBrainz";
    return h.replace("www.", "") || openWord;
  } catch {
    return openWord;
  }
}

export function findLibTrack(
  library: LibraryResponse,
  relPath: string
): LibTrack | null {
  for (const a of library.artists) {
    for (const al of a.albums) {
      for (const t of al.tracks) {
        if (t.relPath === relPath) return t;
      }
    }
  }
  return null;
}

export function artistNameForAlbumRelPath(
  library: LibraryResponse,
  albumRelPath: string,
): string {
  for (const a of library.artists) {
    for (const al of a.albums) {
      const rp = al.relPath || `${a.name}/${al.name}`;
      if (rp === albumRelPath) return a.name;
    }
  }
  return "";
}

export const REKORD_DL_OK = "rekord-dl-committed";
export const LEGACY_DL_OK = "wpp-dl-committed";
export const REKORD_DL_OUT = "rekord-dl-out";
export const LEGACY_DL_OUT = "wpp-dl-out";
export const K_COVER_ALB = "rekord-cover-album";
export const LEGACY_COVER_ALB = "wpp-cover-album";
export const REKORD_DL_STUDIO_MODE = "rekord-dl-studio-mode";
export const REKORD_CATALOG_STUDIO_MODE = "rekord-catalog-studio-mode";

export function migrateSessionKey(primary: string, legacy: string): string | null {
  try {
    const current = sessionStorage.getItem(primary);
    if (current != null) return current;
    const legacyVal = sessionStorage.getItem(legacy);
    if (legacyVal == null) return null;
    sessionStorage.setItem(primary, legacyVal);
    sessionStorage.removeItem(legacy);
    return legacyVal;
  } catch {
    return null;
  }
}

export function migrateSessionFlag(primary: string, legacy: string): boolean {
  try {
    if (sessionStorage.getItem(primary) === "1") return true;
    if (sessionStorage.getItem(legacy) !== "1") return false;
    sessionStorage.setItem(primary, "1");
    sessionStorage.removeItem(legacy);
    return true;
  } catch {
    return false;
  }
}

export function clearLegacySessionKeys() {
  try {
    sessionStorage.removeItem(LEGACY_DL_OK);
    sessionStorage.removeItem(LEGACY_DL_OUT);
    sessionStorage.removeItem(LEGACY_COVER_ALB);
  } catch {
    /* ignore */
  }
}

export type StudioPane = StudioPaneId;
export type DlStudioMode = "classic" | "explore";
export type CatalogStudioMode = "local" | "web";

export function readStoredDlStudioMode(): DlStudioMode {
  try {
    const v = localStorage.getItem(REKORD_DL_STUDIO_MODE);
    if (v === "explore") return "explore";
  } catch {
    /* ignore */
  }
  return "classic";
}

export function readStoredCatalogStudioMode(): CatalogStudioMode {
  try {
    const v = localStorage.getItem(REKORD_CATALOG_STUDIO_MODE);
    if (v === "web") return "web";
  } catch {
    /* ignore */
  }
  return "local";
}

export function readStoredStudioPane(): StudioPane | null {
  try {
    const v = localStorage.getItem(REKORD_STUDIO_PANE);
    if (v === "shared") return "catalog";
    if (
      v === "listen" ||
      v === "catalog" ||
      v === "download" ||
      v === "meta" ||
      v === "covers"
    ) {
      return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isRekordClientEmbed(): boolean {
  try {
    return sessionStorage.getItem("rekord-embed") === "client";
  } catch {
    return false;
  }
}

export function selectionHasArtist(sel: LibrarySelectionV1 | null, artistId: string) {
  if (!sel) return false;
  if (sel.includeAll) return true;
  return sel.artists.includes(artistId);
}

export function selectionHasAlbum(
  sel: LibrarySelectionV1 | null,
  albumRel: string,
  artistId: string,
) {
  if (!sel) return false;
  if (sel.includeAll) return true;
  if (sel.artists.includes(artistId)) return true;
  return sel.albums.includes(albumRel);
}

export function indexHasArtist(index: LibraryIndex | null, artistId: string) {
  if (!index?.artists?.length) return false;
  return index.artists.some((a) => a.id === artistId);
}

export function indexHasAlbum(index: LibraryIndex | null, relPath: string) {
  if (!index?.albums?.length) return false;
  return index.albums.some((a) => a.relPath === relPath);
}

export function catalogArtistCoverRel(ar: CatalogArtistEntry): string | null {
  if (ar.coverRelPath?.trim()) return ar.coverRelPath;
  const c = ar.relAlbums.find((x) => x.coverRelPath);
  if (c?.coverRelPath) return c.coverRelPath;
  return ar.relAlbums[0]?.relPath ?? null;
}

/** Artist not in account selection, or at least one catalog album folder missing from local index. */
export function catalogArtistNeedsAttention(
  ar: CatalogArtistEntry,
  index: LibraryIndex | null,
  sel: LibrarySelectionV1 | null,
) {
  const notInSelection = !selectionHasArtist(sel, ar.id);
  const missingAlbum =
    ar.relAlbums.length > 0 &&
    ar.relAlbums.some((al) => !indexHasAlbum(index, al.relPath));
  return notInSelection || missingAlbum;
}

export function exploreTypeLabel(
  type: YoutubeExploreResult["type"],
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (type === "album") return t("tools.exploreTypeAlbum");
  if (type === "artist") return t("tools.exploreTypeArtist");
  return t("tools.exploreTypeSong");
}

export function exploreScopeForItem(item: YoutubeExploreResult): StudioDownloadScope {
  return item.type === "song" ? "single" : "playlist";
}

export function exploreDownloadPreamble(
  item: YoutubeExploreResult,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const typeLabel = exploreTypeLabel(item.type, t);
  let msg = t("tools.exploreConfirmLead", {
    type: typeLabel,
    title: item.title,
  });
  if (item.subtitle?.trim()) {
    msg +=
      "\n" +
      t("tools.exploreConfirmSubtitle", {
        subtitle: item.subtitle.trim(),
      });
  }
  if (item.url?.trim()) {
    msg += "\n" + t("tools.exploreConfirmUrl", { url: item.url.trim() });
  }
  return msg;
}

export function buildReleasesArtistFolderConfirm(args: {
  dlPath: string;
  entries: { title: string }[];
  libraryIndex: LibraryIndex | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): string {
  const norm = normalizeDownloadDestPath(args.dlPath);
  const rows: { path: string; exists: boolean }[] = [];
  const seen = new Set<string>();
  for (const e of args.entries) {
    const rel = joinMusicDestRelPath(norm, e.title);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    rows.push({
      path: rel,
      exists: indexHasAlbum(args.libraryIndex, rel),
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const max = 45;
  const shown = rows.slice(0, max);
  const lines = shown.map((r) =>
    r.exists
      ? args.t("tools.dlReleasesRowUpdate", { path: r.path })
      : args.t("tools.dlReleasesRowNew", { path: r.path }),
  );
  let msg =
    args.t("tools.dlReleasesArtistConfirmLead", {
      count: rows.length,
      base: norm,
    }) +
    "\n\n" +
    lines.join("\n");
  if (rows.length > max) {
    msg += "\n" + args.t("tools.dlReleasesRowMore", { n: rows.length - max });
  }
  msg +=
    "\n\n" +
    args.t("tools.dlReleasesFolderNameHint") +
    "\n\n" +
    args.t("tools.dlReleasesProceedQ");
  return msg;
}

export async function prepareStudioDownload(args: {
  hasValidDownloadDest: boolean;
  dlPath: string;
  scope: StudioDownloadScope;
  releaseTitle?: string;
  trackCount: number | null;
  preamble?: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  appConfirm: (opts: {
    variant?: "danger" | "warning";
    message: string;
  }) => Promise<boolean>;
  onLog: (updater: (prev: string) => string) => void;
}): Promise<boolean> {
  if (!args.hasValidDownloadDest) {
    args.onLog((x) => x + args.t("tools.dlPickFolder"));
    return false;
  }
  const confirmOpts = buildStudioDownloadConfirm({
    dlPath: args.dlPath,
    scope: args.scope,
    releaseTitle: args.releaseTitle,
    trackCount: args.trackCount,
    t: args.t,
    preamble: args.preamble,
  });
  if (!(await args.appConfirm(confirmOpts))) {
    return false;
  }
  if (args.scope === "playlist" && args.trackCount != null && args.trackCount > 35) {
    if (
      !(await args.appConfirm({
        message: args.t("tools.dlPlaylistManyConfirm", { n: args.trackCount }),
      }))
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeDlProgress(
  p: { current: number; total: number } | null
): { cur: number; tot: number; pct: number } | null {
  if (!p) return null;
  const tot = Math.max(1, Math.floor(Number(p.total) || 1));
  const cur = Math.min(tot, Math.max(0, Math.floor(Number(p.current) || 0)));
  return { cur, tot, pct: Math.max(3, Math.min(100, (cur / tot) * 100)) };
}

/** Brani nel singolo album (release batch); se total non noto ancora, pct leggera fissa. */
export function normalizeTrackInAlbumProgress(
  p: { current: number; total: number } | null
): { cur: number; tot: number; pct: number; hasTotal: boolean } | null {
  if (!p) return null;
  const tot = Math.floor(Number(p.total) || 0);
  const cur = Math.max(0, Math.floor(Number(p.current) || 0));
  if (tot <= 0) {
    return { cur, tot: 0, pct: 10, hasTotal: false };
  }
  return {
    cur: Math.min(tot, cur),
    tot,
    hasTotal: true,
    pct: Math.max(3, Math.min(100, (cur / tot) * 100)),
  };
}
