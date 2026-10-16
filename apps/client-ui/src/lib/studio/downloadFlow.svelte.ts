/**
 * One-item download flow shared by Download › Classico / Esplora and Scopri:
 * validate, open the confirm dialog *at once* (the playlist track count fills
 * in while yt-dlp counts), then start the job in the download store.
 *
 * `StudioDownloadConfirmDialog` (mounted once in StudioView) renders
 * `downloadFlow.current`; the panes read `downloadFlow.pendingUrl` for the
 * per-item busy state, and the flow refuses a second request while one is open.
 */
import { downloadFlatCount } from "../api/studio";
import { t, tp } from "../i18n.svelte";
import {
  isValidDownloadDestPath,
  normalizeDownloadDestPath,
  relPathLooksLikeAlbumFolderDest,
  resolveStudioDownloadOutputDir,
  studioDownloadKindForScope,
  type StudioDownloadScope,
} from "../studioDownloadDest";
import { looksLikeSupportedDownloadUrl } from "../youtubeUrl";
import { studioDownloads as dl } from "./downloadStore.svelte";
import { studioCodeText, studioErrorText } from "./errors";
import type { LibraryHit } from "./libraryMatch";

/** Destination picked in the Download pane (per tab, like the legacy client). */
export const DEST_KEY = "rekord-dl-output";
export const DEST_OK_KEY = "rekord-dl-ok";

/** Give up on the track count after this long: the dialog says "unknown". */
const COUNT_TIMEOUT_MS = 35_000;

export function readSavedDownloadDest(): string {
  try {
    if (sessionStorage.getItem(DEST_OK_KEY) !== "1") return "";
    return normalizeDownloadDestPath(sessionStorage.getItem(DEST_KEY) || "");
  } catch {
    return "";
  }
}

export type DownloadAsk = {
  url: string;
  scope: StudioDownloadScope;
  /** Shown in the dialog head. */
  title: string;
  subtitle?: string | null;
  thumbnailUrl?: string | null;
  /** Playlist / album under an artist folder: sub-folder name. */
  releaseTitle?: string;
  destPath: string;
  library?: LibraryHit | null;
};

export type CountState = "none" | "counting" | "known" | "unknown";
/** Why the item cannot be downloaded from here (the dialog offers to pick a folder). */
export type DestIssue = "pickDest" | "singleNeedsAlbum" | null;
export type FlowResult = "started" | "cancelled" | "pickDest" | "busy";

export type ConfirmState = {
  id: number;
  ask: DownloadAsk;
  count: CountState;
  trackCount: number | null;
  destIssue: DestIssue;
  /** Output folder the job will write to. */
  outputDir: string;
  /** Picked folder is an artist folder (the album gets its own sub-folder, or a single lands loose). */
  artistFolderTarget: boolean;
};

function destIssueFor(dest: string, scope: StudioDownloadScope): DestIssue {
  if (!isValidDownloadDestPath(dest)) return "pickDest";
  if (scope === "single" && !relPathLooksLikeAlbumFolderDest(dest)) return "singleNeedsAlbum";
  return null;
}

class DownloadFlow {
  current = $state<ConfirmState | null>(null);
  /** URL whose request is open or starting: its button shows a spinner. */
  pendingUrl = $state<string | null>(null);

  private seq = 0;
  private resolveFn: ((r: "download" | "cancel" | "pickDest") => void) | null = null;
  private countAbort: AbortController | null = null;

  get open(): boolean {
    return this.current != null;
  }

  /** Answer the dialog (ignored when it is not the open one). */
  settle(id: number, result: "download" | "cancel" | "pickDest") {
    if (!this.current || this.current.id !== id) return;
    this.countAbort?.abort();
    this.countAbort = null;
    this.current = null;
    const r = this.resolveFn;
    this.resolveFn = null;
    r?.(result);
  }

  private async count(id: number, url: string) {
    const ctrl = new AbortController();
    this.countAbort = ctrl;
    const timer = setTimeout(() => ctrl.abort(), COUNT_TIMEOUT_MS);
    let n: number | null = null;
    try {
      const r = await downloadFlatCount(url.trim(), { signal: ctrl.signal, timeoutMs: COUNT_TIMEOUT_MS + 5000 });
      const v = Number(r.count);
      if (r.count != null && r.known !== false && Number.isFinite(v) && v > 0) n = v;
      else if (this.current?.id === id) {
        dl.log("warn", t("studio.dl.logCountUnknown", { error: studioCodeText(r.error ?? "flat_count_failed", null) }));
      }
    } catch (e) {
      // Closed dialog: nobody needs the number any more.
      if (this.current?.id !== id) return;
      const timedOut = ctrl.signal.aborted;
      dl.log(
        "warn",
        t("studio.dl.logCountUnknown", { error: timedOut ? t("studio.dl.countTimeout") : studioErrorText(e) }),
      );
    } finally {
      clearTimeout(timer);
      if (this.countAbort === ctrl) this.countAbort = null;
    }
    const cur = this.current;
    if (!cur || cur.id !== id) return;
    if (n != null) dl.log("info", tp("studio.dl.logPlaylistCount", n));
    this.current = { ...cur, count: n != null ? "known" : "unknown", trackCount: n };
  }

  /**
   * Ask, then start. Throws (translated) when the URL itself is unusable; a
   * missing or wrong destination is shown in the dialog instead.
   */
  async run(ask: DownloadAsk): Promise<FlowResult> {
    if (this.current || this.pendingUrl || dl.busy) return "busy";
    const url = ask.url.trim();
    if (!url) throw new Error(t("studio.dl.errUrlMissing"));
    if (!looksLikeSupportedDownloadUrl(url)) throw new Error(t("studio.dl.errUrlUnsupported"));
    const dest = normalizeDownloadDestPath(ask.destPath);
    const destIssue = destIssueFor(dest, ask.scope);
    const outputDir = resolveStudioDownloadOutputDir(dest, ask.scope, ask.releaseTitle);
    const artistFolderTarget =
      ask.scope === "single"
        ? !relPathLooksLikeAlbumFolderDest(dest)
        : !relPathLooksLikeAlbumFolderDest(outputDir);
    const id = ++this.seq;
    const counting = ask.scope === "playlist" && !destIssue;
    this.pendingUrl = url;
    try {
      const answer = new Promise<"download" | "cancel" | "pickDest">((resolve) => {
        this.resolveFn = resolve;
      });
      this.current = {
        id,
        ask: { ...ask, url, destPath: dest },
        count: counting ? "counting" : "none",
        trackCount: null,
        destIssue,
        outputDir,
        artistFolderTarget,
      };
      if (counting) void this.count(id, url);
      const r = await answer;
      if (r === "pickDest") return "pickDest";
      if (r !== "download" || destIssue) return "cancelled";
      // The job owns the busy state from here on; the flow is free again.
      // Status card title: the release / track name, not a bare link.
      const jobTitle = ask.releaseTitle ?? (ask.title && ask.title !== url ? ask.title : undefined);
      void dl.runSingle(url, studioDownloadKindForScope(ask.scope), outputDir, jobTitle);
      return "started";
    } finally {
      this.pendingUrl = null;
    }
  }
}

export const downloadFlow = new DownloadFlow();
