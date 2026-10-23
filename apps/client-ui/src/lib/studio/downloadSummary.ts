/**
 * What a finished download did, from the hub's `done` event. Pure (no i18n),
 * so it can be tested with `node --test`.
 */
import { foldText } from "../search";
import { joinMusicDestRelPath, normalizeDownloadDestPath } from "../studioDownloadDest";

export type SummaryItem = { label: string; reason: string; code?: string | null };

export type DownloadSummary = {
  downloaded: number;
  skipped: number;
  failed: number;
  skippedItems: SummaryItem[];
  failedItems: SummaryItem[];
};

type DoneLike = {
  /** New hubs nest the counts: `summary: { downloaded, skipped, failed, total }`. */
  summary?: unknown;
  downloaded?: unknown;
  skipped?: unknown;
  failed?: unknown;
  downloadedItems?: unknown;
  skippedItems?: unknown;
  failedItems?: unknown;
};

function items(v: unknown): SummaryItem[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === "string") return { label: x, reason: "" };
    const o = (x ?? {}) as Record<string, unknown>;
    const code = typeof o.code === "string" && o.code !== "unknown" ? o.code : null;
    return {
      label: String(o.label ?? o.title ?? o.id ?? ""),
      reason: String(o.reason ?? o.error ?? ""),
      ...(code ? { code } : {}),
    };
  });
}

function count(explicit: unknown, list: unknown): number {
  const n = Number(explicit);
  if (explicit != null && Number.isFinite(n) && n >= 0) return Math.trunc(n);
  return Array.isArray(list) ? list.length : 0;
}

/** Counts from the new per-item fields, falling back to the item arrays. */
export function summaryFromEvent(ev: DoneLike): DownloadSummary {
  const nested = (ev.summary && typeof ev.summary === "object" ? ev.summary : {}) as {
    downloaded?: unknown;
    skipped?: unknown;
    failed?: unknown;
  };
  return {
    downloaded: count(nested.downloaded ?? ev.downloaded, ev.downloadedItems),
    skipped: count(nested.skipped ?? ev.skipped, ev.skippedItems),
    failed: count(nested.failed ?? ev.failed, ev.failedItems),
    skippedItems: items(ev.skippedItems),
    failedItems: items(ev.failedItems),
  };
}

export function summaryIsEmpty(s: DownloadSummary): boolean {
  return s.downloaded + s.skipped + s.failed === 0;
}

export type JobOutcome = "ok" | "partial" | "failed" | "cancelled";

/** One release of a batch, as the batch summary counts it. */
export function jobOutcome(ok: boolean, cancelled: boolean, s: DownloadSummary): JobOutcome {
  if (cancelled) return "cancelled";
  if (!ok) return s.downloaded > 0 ? "partial" : "failed";
  return s.failed > 0 ? "partial" : "ok";
}

export function batchCounts(rows: JobOutcome[]) {
  return {
    ok: rows.filter((r) => r === "ok").length,
    partial: rows.filter((r) => r === "partial").length,
    failed: rows.filter((r) => r === "failed").length,
    cancelled: rows.filter((r) => r === "cancelled").length,
  };
}

export type PlannedRelease = { path: string; exists: boolean };

/**
 * Folders a releases batch will write under `base`, flagging those already in
 * the library ("files will be added there") — legacy
 * `buildReleasesArtistFolderConfirm`.
 */
/**
 * Key for "is this folder already in the library": each segment folded
 * (accents, case) and reduced to letters and digits, so a title typed as
 * "What?!" matches the folder yt-dlp wrote as "What？!" (full-width) or an
 * album saved as "What !". A segment with no letter or digit at all ("( )")
 * keeps its folded text instead of vanishing.
 */
export function folderMatchKey(relPath: string): string {
  return normalizeDownloadDestPath(relPath)
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      const folded = foldText(seg);
      const alnum = folded.replace(/[^\p{L}\p{N}]+/gu, "");
      return alnum || folded.replace(/\s+/g, " ").trim();
    })
    .join("/");
}

export function plannedReleaseFolders(
  base: string,
  titles: string[],
  existingFolderKeys: Iterable<string>,
): PlannedRelease[] {
  const norm = normalizeDownloadDestPath(base);
  const known = new Set<string>();
  for (const k of existingFolderKeys) known.add(folderMatchKey(k));
  const seen = new Set<string>();
  const rows: PlannedRelease[] = [];
  for (const title of titles) {
    const rel = joinMusicDestRelPath(norm, title);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    rows.push({ path: rel, exists: known.has(folderMatchKey(rel)) });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

/**
 * What a sign-in / age-gate failure asks the user to fix, as i18n keys: with
 * cookies in place and no JavaScript runtime the runtime is the culprit
 * (YouTube refuses yt-dlp without one even with valid cookies).
 */
export function signInHintKeys(cookiesConfigured: boolean, jsRuntimeMissing: boolean): string[] {
  if (!jsRuntimeMissing) return ["studio.dl.cookieHint"];
  return cookiesConfigured ? ["studio.dl.jsRuntimeHint"] : ["studio.dl.cookieHint", "studio.dl.jsRuntimeHint"];
}
