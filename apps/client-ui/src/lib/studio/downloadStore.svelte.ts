/**
 * Studio downloads, kept outside the pane: switching to another Studio tab (or
 * another page) unmounts the Download pane, but the yt-dlp job, its progress,
 * its log and the Cancel button must survive — the hub kills yt-dlp when the
 * client drops the stream, so the stream itself lives here too.
 *
 * A job started elsewhere (another tab, before a reload) is re-attached through
 * `GET /download/active?downloadId=…&stream=1` when the hub supports it.
 */
import { api } from "../api";
import {
  attachDownloadStream,
  downloadActive,
  downloadCancel,
  isActiveDownload,
  isUnsupported,
  startDownloadStream,
  type ActiveDownload,
  type DownloadEvent,
} from "../api/studio";
import { t, tp } from "../i18n.svelte";
import { session } from "../session.svelte";
import type { DlVideoMode } from "../youtubeUrl";
import {
  batchCounts,
  jobOutcome,
  signInHintKeys,
  summaryFromEvent,
  summaryIsEmpty,
  type DownloadSummary,
  type JobOutcome,
  type SummaryItem,
} from "./downloadSummary";
import { studioCodeText, studioErrorText } from "./errors";
import { detectDownloadIssue, isCookieIssueCode, redactPaths, ytdlpLogDetailForUser } from "./ytdlpLogFilter";

export type Progress = { current: number; total: number };
export type LogKind = "info" | "ok" | "warn" | "error" | "detail";
export type LogEntry = { id: number; kind: LogKind; text: string };

/** Lines kept in the user log; older ones scroll away. */
const LOG_MAX = 400;
/** Raw yt-dlp text kept for the "full log" toggle. */
const RAW_MAX = 60_000;
const ITEM_LINES_MAX = 8;
const ACTIVE_POLL_MS = 2500;
const SCAN_WAIT_MAX_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JobResult = {
  outcome: JobOutcome;
  summary: DownloadSummary;
  /** The hub indexed the new files before answering (`indexEpoch`). */
  indexed: boolean;
};

/** What one stream (own job or re-attached) has seen so far. */
type JobTrack = {
  done: JobResult | null;
  items: DownloadEvent | null;
  /** Items already reported live (`item` events): skip them in the summary. */
  liveItems: Set<string>;
  /** `log` events arrived: the raw log is already filled. */
  liveRaw: boolean;
};

function kindLabel(kind: string): string {
  if (kind === "download_single") return t("studio.dl.kind.single");
  if (kind === "download_playlist") return t("studio.dl.kind.playlist");
  if (kind === "download_releases" || kind === "download_ytmusic") return t("studio.dl.kind.releases");
  return t("studio.dl.kind.other");
}

function errorField(ev: DownloadEvent): { code: string | null; message: string | null } {
  if (typeof ev.errorCode === "string") return { code: ev.errorCode, message: null };
  const e = ev.error;
  if (typeof e === "string") {
    return /^[a-z0-9_]+$/.test(e) ? { code: e, message: null } : { code: null, message: e };
  }
  if (e && typeof e === "object") {
    return { code: typeof e.code === "string" ? e.code : null, message: e.message ?? null };
  }
  return { code: null, message: typeof ev.message === "string" ? ev.message : null };
}

function itemKey(it: { id?: unknown; index?: unknown; title?: unknown; label?: unknown }): string {
  return String(it.id ?? it.index ?? it.title ?? it.label ?? "");
}

class StudioDownloads {
  /** Download pane form, kept across remounts. */
  studioMode = $state<"classic" | "explore">("classic");
  url = $state("");
  urlMode = $state<DlVideoMode>("single");

  busy = $state(false);
  activeId = $state<string | null>(null);
  activeTitle = $state<string | null>(null);
  progress = $state<Progress | null>(null);
  batch = $state<Progress | null>(null);
  stopRequested = $state(false);
  /** The hub is indexing the new files / the client reloads the library. */
  refreshing = $state(false);
  /** The last job hit YouTube's sign-in / age gate: cookies missing or expired. */
  cookieIssue = $state(false);
  /** Hub setup from the download preset (the Download pane fills these in). */
  cookiesConfigured = $state(true);
  jsRuntimeMissing = $state(false);

  entries = $state<LogEntry[]>([]);
  raw = $state("");
  showRaw = $state(false);

  /** Jobs running on the hub that this tab did not start (other tab, reload). */
  remote = $state<ActiveDownload[]>([]);
  /** null: not asked yet; false: hub has no `download/active`. */
  activeSupported = $state<boolean | null>(null);

  private seq = 0;
  private cookieHintLogged = false;
  private controller: AbortController | null = null;
  private batchStop = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private attaching = false;

  get running(): boolean {
    return this.busy || this.remote.length > 0;
  }

  log(kind: LogKind, text: string) {
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) return;
    const next = this.entries.concat(lines.map((l) => ({ id: ++this.seq, kind, text: l })));
    this.entries = next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
  }

  clearLog() {
    this.entries = [];
    this.raw = "";
  }

  private appendRaw(text: string) {
    const clean = redactPaths(text, [session.stats?.music_root]).trimEnd();
    if (!clean.trim()) return;
    const next = this.raw ? `${this.raw}\n${clean}` : clean;
    this.raw = next.length > RAW_MAX ? next.slice(next.length - RAW_MAX) : next;
  }

  private summaryLine(s: DownloadSummary): string {
    const parts = [tp("studio.dl.sum.downloaded", s.downloaded)];
    if (s.skipped) parts.push(tp("studio.dl.sum.skipped", s.skipped));
    if (s.failed) parts.push(tp("studio.dl.sum.failed", s.failed));
    return t("studio.dl.sum.line", { parts: parts.join(" · ") });
  }

  private reasonText(it: { reason?: string | null; code?: string | null }): string {
    if (it.code) return studioCodeText(it.code, it.reason ?? null);
    const r = (it.reason ?? "").trim();
    if (!r) return "";
    if (/already (been )?downloaded|already exists|già/i.test(r)) return t("studio.dl.sum.reasonAlready");
    return studioCodeText(/^[a-z0-9_]+$/.test(r) ? r : null, r);
  }

  private skippedLine(it: SummaryItem) {
    const reason = this.reasonText(it) || t("studio.dl.sum.reasonAlready");
    this.log("detail", t("studio.dl.sum.skippedLine", { label: redactPaths(it.label), reason }));
  }

  private failedLine(it: SummaryItem) {
    const reason = this.reasonText(it);
    this.log(
      "error",
      reason
        ? t("studio.dl.sum.failedLine", { label: redactPaths(it.label), reason })
        : t("studio.dl.sum.failedLineBare", { label: redactPaths(it.label) }),
    );
  }

  /** One playlist entry finished (live `item` event). */
  private reportItem(raw: unknown, track: JobTrack) {
    const it = (raw ?? {}) as {
      id?: string;
      index?: number;
      title?: string;
      status?: string;
      reason?: string;
      code?: string;
    };
    const status = it.status;
    if (status !== "downloaded" && status !== "skipped" && status !== "failed") return;
    const key = itemKey(it);
    if (!key || track.liveItems.has(key)) return;
    track.liveItems.add(key);
    const label = it.title || (it.index != null ? `#${it.index}` : (it.id ?? ""));
    const item: SummaryItem = { label, reason: it.reason ?? "", code: it.code ?? null };
    if (status === "failed" && isCookieIssueCode(it.code)) this.cookieIssue = true;
    if (status === "downloaded") this.log("ok", t("studio.dl.itemDone", { label: redactPaths(label) }));
    else if (status === "skipped") this.skippedLine(item);
    else this.failedLine(item);
  }

  /** Log what a finished job did; returns its outcome. */
  private reportDone(ev: DownloadEvent, track: JobTrack): JobResult {
    const summary = summaryFromEvent(ev);
    const ok = ev.ok === true;
    const cancelled = ev.cancelled === true;
    const outcome = jobOutcome(ok, cancelled, summary);
    const rawText = [ev.stdout, ev.stderr].filter(Boolean).join("\n");
    if (!track.liveRaw) this.appendRaw(rawText);

    if (!summaryIsEmpty(summary)) {
      this.log(summary.failed ? "warn" : "info", this.summaryLine(summary));
      // Items already reported live (`item` events) are not repeated; the done
      // lists carry no stable id, so live reporting replaces them entirely.
      const live = track.liveItems.size > 0;
      const skipped = live ? [] : summary.skippedItems;
      const failed = live ? [] : summary.failedItems;
      for (const it of skipped.slice(0, ITEM_LINES_MAX)) this.skippedLine(it);
      for (const it of failed.slice(0, ITEM_LINES_MAX)) this.failedLine(it);
      const hidden =
        Math.max(0, skipped.length - ITEM_LINES_MAX) + Math.max(0, failed.length - ITEM_LINES_MAX);
      if (hidden) this.log("detail", tp("studio.dl.sum.more", hidden));
    }

    if (cancelled) {
      const reason = typeof ev.cancelReason === "string" ? ev.cancelReason : null;
      this.log(
        "warn",
        reason === "client_disconnected" ? t("studio.err.clientDisconnected") : t("studio.dl.logCancelled"),
      );
    } else if (!ok) {
      const err = errorField(ev);
      const issue = detectDownloadIssue(err.code, rawText);
      if (issue === "sign_in") this.cookieIssue = true;
      if (issue === "no_audio_format") this.log("error", t("studio.err.noAudioFormat"));
      else if (issue === "http_403") this.log("error", t("studio.err.ytdlp403"));
      else if (issue === "ytdlp_missing") this.log("error", t("studio.err.ytdlpMissing"));
      else if (err.code && err.code !== "ytdlp_failed" && issue !== "sign_in") {
        // Sign-in / age gate: the cookie hint below says it better.
        this.log("error", studioCodeText(err.code, err.message));
      }
      if (!summary.failedItems.length) {
        const detail = ytdlpLogDetailForUser({
          ok,
          stderr: ev.stderr ?? "",
          stdout: ev.stdout ?? "",
          error: err.message,
        });
        if (detail) {
          const lines = redactPaths(detail, [ev.musicRoot, session.stats?.music_root])
            .split("\n")
            .slice(0, 6);
          this.log("detail", lines.join("\n"));
        }
      }
      this.log("error", summary.downloaded ? t("studio.dl.logFailedPartial") : t("studio.dl.logFailedNone"));
    } else if (outcome === "partial") {
      this.log("warn", t("studio.dl.logDonePartial"));
      if (summary.failedItems.some((it) => isCookieIssueCode(it.code))) this.cookieIssue = true;
    } else {
      this.log("ok", t("studio.dl.logDone"));
    }
    if (typeof ev.rescanError === "string" && ev.rescanError) {
      this.log("warn", t("studio.dl.rescanFailed"));
    }
    if (this.cookieIssue && !cancelled && !this.cookieHintLogged) {
      this.cookieHintLogged = true;
      for (const key of signInHintKeys(this.cookiesConfigured, this.jsRuntimeMissing)) this.log("warn", t(key));
    }
    return { outcome, summary, indexed: typeof ev.indexEpoch === "number" };
  }

  /** Shared handling of a job's NDJSON events. */
  private onJobEvent(ev: DownloadEvent, track: JobTrack) {
    switch (ev.type) {
      case "progress":
        if (ev.progress) this.progress = ev.progress;
        break;
      case "started":
        this.log("info", t("studio.dl.logStarted"));
        break;
      case "item":
        this.reportItem(ev.item, track);
        break;
      case "log":
        if (typeof ev.line === "string") {
          track.liveRaw = true;
          this.appendRaw(ev.line);
        }
        break;
      case "tagged": {
        // Tags and cover the hub wrote into the new files (5.2).
        const tagged = typeof ev.tagged === "number" ? ev.tagged : 0;
        if (tagged > 0) this.log("info", tp("studio.dl.logTagged", tagged));
        if (Array.isArray(ev.coverFiles)) {
          for (const path of ev.coverFiles) this.log("info", t("studio.dl.logCoverSaved", { path: String(path) }));
        }
        const failed = Array.isArray(ev.failed) ? ev.failed.length : 0;
        if (failed > 0) this.log("warn", tp("studio.dl.logTagsFailed", failed));
        break;
      }
      case "indexing":
        this.refreshing = true;
        this.log("info", t("studio.dl.logIndexing"));
        break;
      case "items":
        track.items = ev;
        break;
      case "snapshot": {
        const d = (ev.download ?? {}) as { progress?: Progress | null; logTail?: unknown };
        if (d.progress) this.progress = d.progress;
        if (Array.isArray(d.logTail)) {
          track.liveRaw = true;
          this.appendRaw(d.logTail.map(String).join("\n"));
        }
        break;
      }
      case "error": {
        const err = errorField(ev);
        this.log("error", studioCodeText(err.code, err.message));
        break;
      }
      case "done":
        track.done = this.reportDone(track.items ? { ...track.items, ...ev } : ev, track);
        break;
    }
  }

  private newTrack(): JobTrack {
    return { done: null, items: null, liveItems: new Set(), liveRaw: false };
  }

  private fallbackResult(track: JobTrack): JobResult {
    const summary = summaryFromEvent(track.items ?? {});
    return {
      outcome: this.stopRequested ? "cancelled" : summary.downloaded ? "partial" : "failed",
      summary,
      indexed: false,
    };
  }

  /** One yt-dlp job; never throws (failures are logged and returned). */
  private async runJob(url: string, kind: string, outputDir: string): Promise<JobResult> {
    const id = crypto.randomUUID();
    this.activeId = id;
    this.progress = null;
    const controller = new AbortController();
    this.controller = controller;
    const track = this.newTrack();
    this.log(
      "info",
      t("studio.dl.logStart", { kind: kindLabel(kind), path: outputDir || t("studio.dl.logRoot") }),
    );
    try {
      await startDownloadStream(
        { url: url.trim(), downloadId: id, downloadKind: kind, outputDir },
        (ev) => this.onJobEvent(ev, track),
        controller.signal,
      );
    } catch (e) {
      if (!track.done) this.log("error", t("studio.dl.logError", { error: studioErrorText(e) }));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.activeId = null;
      this.progress = null;
    }
    return track.done ?? this.fallbackResult(track);
  }

  /** Library scan stamp before a job, to know when the post-download scan ran. */
  private async scanStamp(): Promise<string | null> {
    try {
      const s = await api.stats();
      return s.last_scan_at ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reload the library once the hub has indexed the new files. New hubs index
   * before `done` (`indexEpoch`); older ones rescan afterwards, so wait for a
   * scan newer than `stampBefore` to finish.
   */
  private async refreshLibrary(indexed: boolean, stampBefore: string | null) {
    this.refreshing = true;
    try {
      if (!indexed) {
        this.log("info", t("studio.dl.logIndexing"));
        const until = Date.now() + SCAN_WAIT_MAX_MS;
        await sleep(600);
        while (Date.now() < until) {
          try {
            const s = await api.stats();
            if (!s.scanning && (s.last_scan_at ?? null) !== stampBefore) break;
          } catch {
            break;
          }
          await sleep(1000);
        }
      }
      await session.refreshAll();
      this.log("ok", t("studio.dl.logLibraryUpdated"));
    } finally {
      this.refreshing = false;
    }
  }

  private shouldRefresh(r: JobResult): boolean {
    if (r.outcome === "cancelled") return r.summary.downloaded > 0;
    return r.summary.downloaded > 0 || (r.outcome === "ok" && summaryIsEmpty(r.summary));
  }

  /** Single URL (track, album or playlist). */
  async runSingle(url: string, kind: string, outputDir: string, title?: string) {
    if (this.busy) return;
    this.stopPolling();
    this.busy = true;
    this.stopRequested = false;
    this.cookieIssue = false;
    this.cookieHintLogged = false;
    this.activeTitle = title ?? null;
    try {
      const stamp = await this.scanStamp();
      const r = await this.runJob(url, kind, outputDir);
      if (this.shouldRefresh(r)) await this.refreshLibrary(r.indexed, stamp);
    } finally {
      this.busy = false;
      this.refreshing = false;
      this.activeTitle = null;
      this.stopRequested = false;
    }
  }

  /** Several releases, one sub-folder each, with a batch summary at the end. */
  async runBatch(list: Array<{ title: string; url: string; outputDir: string }>, kind: string) {
    if (this.busy || !list.length) return;
    this.stopPolling();
    this.busy = true;
    this.batchStop = false;
    this.stopRequested = false;
    this.cookieIssue = false;
    this.cookieHintLogged = false;
    const outcomes: JobOutcome[] = [];
    let anyNew = false;
    let allIndexed = true;
    try {
      const stamp = await this.scanStamp();
      this.batch = { current: 0, total: list.length };
      this.log("info", tp("studio.dl.batchStart", list.length));
      for (let i = 0; i < list.length; i++) {
        if (this.batchStop) {
          this.log("warn", t("studio.dl.logBatchStopped"));
          break;
        }
        const item = list[i]!;
        this.batch = { current: i + 1, total: list.length };
        this.activeTitle = item.title;
        this.refreshing = false;
        this.log("info", t("studio.dl.batchLine", { i: i + 1, n: list.length, title: item.title }));
        const r = await this.runJob(item.url, kind, item.outputDir);
        outcomes.push(r.outcome);
        if (this.shouldRefresh(r)) anyNew = true;
        if (!r.indexed) allIndexed = false;
        if (r.outcome === "cancelled") break;
      }
      const c = batchCounts(outcomes);
      const parts = [tp("studio.dl.batchSum.ok", c.ok)];
      if (c.partial) parts.push(tp("studio.dl.batchSum.partial", c.partial));
      if (c.failed) parts.push(tp("studio.dl.batchSum.failed", c.failed));
      const skipped = list.length - outcomes.length + c.cancelled;
      if (skipped > 0) parts.push(tp("studio.dl.batchSum.skipped", skipped));
      this.log(
        c.failed || c.partial ? "warn" : "ok",
        t("studio.dl.batchSum.line", { parts: parts.join(" · ") }),
      );
      if (c.partial || c.failed) this.log("detail", t("studio.dl.batchSum.legend"));
      if (anyNew) await this.refreshLibrary(allIndexed, stamp);
    } finally {
      this.batch = null;
      this.busy = false;
      this.refreshing = false;
      this.activeTitle = null;
      this.stopRequested = false;
    }
  }

  /** Stop the current job (and the rest of a batch). Always available. */
  async cancel() {
    this.batchStop = true;
    this.stopRequested = true;
    const id = this.activeId ?? this.remote.find(isActiveDownload)?.downloadId ?? null;
    if (!id) {
      // Between two batch items: the loop sees `batchStop`.
      return;
    }
    try {
      await downloadCancel(id);
      this.log("warn", t("studio.dl.logCancelRequested"));
    } catch (e) {
      this.log("error", t("studio.dl.logError", { error: studioErrorText(e) }));
      // Last resort: dropping the stream makes the hub kill yt-dlp.
      this.controller?.abort();
    }
  }

  /** Re-attach to jobs started elsewhere (stream when possible, else polling). */
  async attach() {
    if (this.busy || this.attaching) return;
    // The job list is a library operation: a client that cannot manage the
    // library would only collect a 403.
    if (!session.canManageLibrary) return;
    let list: ActiveDownload[] | null;
    try {
      list = await downloadActive();
    } catch {
      return;
    }
    if (list === null) {
      this.activeSupported = false;
      return;
    }
    this.activeSupported = true;
    const running = list.filter(isActiveDownload);
    if (!running.length || this.busy) return;
    const job = running[0]!;
    this.attaching = true;
    this.remote = running;
    this.log("info", tp("studio.dl.remoteRunning", running.length));
    if (job.outputDir != null) {
      this.activeTitle = job.outputDir || t("studio.dl.logRoot");
    }
    const track = this.newTrack();
    const controller = new AbortController();
    this.controller = controller;
    const stamp = await this.scanStamp();
    try {
      await attachDownloadStream(job.downloadId, (ev) => this.onJobEvent(ev, track), controller.signal);
    } catch (e) {
      // Hub lists jobs but cannot stream them: fall back to polling.
      if (isUnsupported(e) || !track.done) {
        this.attaching = false;
        if (this.controller === controller) this.controller = null;
        void this.pollActive();
        return;
      }
    }
    if (this.controller === controller) this.controller = null;
    this.remote = [];
    this.progress = null;
    this.activeTitle = null;
    this.stopRequested = false;
    const r = track.done ?? this.fallbackResult(track);
    try {
      if (this.shouldRefresh(r)) await this.refreshLibrary(r.indexed, stamp);
    } finally {
      this.refreshing = false;
      this.attaching = false;
    }
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Old hubs (or no stream): watch the list until the job is gone. */
  private async pollActive() {
    this.stopPolling();
    if (!session.canManageLibrary) return;
    let list: ActiveDownload[] | null;
    try {
      list = await downloadActive();
    } catch {
      return;
    }
    if (list === null) {
      this.activeSupported = false;
      this.remote = [];
      return;
    }
    const had = this.remote.length > 0;
    this.remote = this.busy ? [] : list.filter(isActiveDownload);
    const p = this.remote.find((r) => r.progress)?.progress;
    if (p) this.progress = p;
    if (this.remote.length) {
      this.pollTimer = setTimeout(() => void this.pollActive(), ACTIVE_POLL_MS);
    } else if (had) {
      this.progress = null;
      this.activeTitle = null;
      this.stopRequested = false;
      this.log("ok", t("studio.dl.remoteDone"));
      void session.refreshAll();
    }
  }
}

export const studioDownloads = new StudioDownloads();
