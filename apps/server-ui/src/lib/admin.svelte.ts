import {
  api,
  type AccessKeyStatus,
  type Account,
  type ActivityEntry,
  type Diagnostics,
  type EmbeddedPriority,
  type EmbeddedStatus,
  type Health,
  type HubConfig,
  type JobEntry,
  type LibraryLayoutConfig,
  type LibraryProbeReport,
  type LibraryStats,
  type MachineAccess,
  type PowerPatch,
  type PowerState,
  type PreferredLayout,
  type RemoteAccessState,
  type ScanMode,
  type WatcherStatus,
  errorText,
  isApiError,
  type LegacyImportReport,
  type LegacyImportStatus,
  type ScanReport,
} from "../api";
import type { StatItem } from "@rekord/ui";
import {
  accessKeyReason,
  clearAccessKey,
  getAccessKey,
  isWellFormedAccessKey,
  onAccessKeyNeeded,
  setAccessKey,
  type AccessKeyReason,
} from "./accessKey";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  t,
  tp,
} from "./i18n.svelte";

export type SectionId =
  | "status"
  | "library"
  | "jobs"
  | "diagnostics"
  | "activity"
  | "backup"
  | "accounts"
  | "integrations"
  | "podcasts"
  | "network";

/** Section ids in rail order; labels are `nav.<id>`, ledes `lede.<id>`. */
export const SECTIONS: SectionId[] = [
  "status",
  "library",
  "jobs",
  "diagnostics",
  "activity",
  "backup",
  "accounts",
  "integrations",
  "podcasts",
  "network",
];

export const humanBytes = formatBytes;
export const humanTime = formatDateTime;
export const humanDuration = formatDuration;

export const LAYOUT_IDS: PreferredLayout[] = ["artist/album/track", "artist/track", "flat", "tags"];

/** Localised name of a library layout id; unknown ids are shown as they are. */
export function layoutLabel(id?: string | null): string {
  if (!id) return "—";
  return (LAYOUT_IDS as string[]).includes(id) ? t(`layout.${id}`) : id;
}

/** What the panel knows about the last scan's removal guard. */
export type PruneNotice = {
  /** Hub reason (English, technical). */
  reason: string;
  missing: number | null;
  /** Where it came from: this session's scan, diagnostics, or the activity log. */
  source: "scan" | "hub" | "activity";
  at: string | null;
};

/** Activity line the hub writes when the guard kept vanished tracks. */
const PRUNE_ACTIVITY_RE = /^(\d+) tracce non trovate ma mantenute: (.+)$/;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class AdminSession {
  section = $state<SectionId>("status");

  health = $state<Health | null>(null);
  stats = $state<LibraryStats | null>(null);
  musicRoot = $state("");
  diagnostics = $state<Diagnostics | null>(null);
  jobs = $state<JobEntry[]>([]);
  layout = $state<LibraryLayoutConfig | null>(null);
  probe = $state<LibraryProbeReport | null>(null);
  watcher = $state<WatcherStatus | null>(null);
  /** Embedded tags / covers (null on hubs older than 5.1). */
  embedded = $state<EmbeddedStatus | null>(null);
  activity = $state<ActivityEntry[]>([]);
  activityDay = $state(today());
  activityScope = $state("all");
  accounts = $state<Account[]>([]);
  defaultAccountId = $state("default");
  newAccountName = $state("");
  config = $state<HubConfig | null>(null);
  discogsToken = $state("");
  remote = $state<RemoteAccessState | null>(null);
  publicIp = $state<string | null>(null);
  access = $state<MachineAccess | null>(null);
  /** Sleep prevention (null on hubs older than 5.1). */
  power = $state<PowerState | null>(null);
  /** Legacy RE-KORD data next to the music, and the last import. */
  legacy = $state<LegacyImportStatus | null>(null);
  /** Report of the last import or preview started from this panel. */
  legacyReport = $state<LegacyImportReport | null>(null);

  /** Report of the last scan started from this panel (the hub keeps no copy). */
  lastScan = $state<ScanReport | null>(null);
  lastScanFinishedAt = $state<string | null>(null);
  /** Latest scan outcome read from today's activity log (scans started elsewhere). */
  activityScan = $state<{ ts: string; notice: PruneNotice | null } | null>(null);

  busy = $state(false);
  message = $state("");
  error = $state("");

  /** The hub wants an access key this browser does not have (or a new one). */
  keyNeeded = $state<AccessKeyReason | null>(null);
  /** Seconds left of a wrong-key lock, when the hub said. */
  keyRetryAfter = $state<number | null>(null);
  /** A key is stored for this hub in this browser. */
  hasAccessKey = $state(getAccessKey() != null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Any call refused for the key (changed on the hub, forgotten) lands here.
    onAccessKeyNeeded((reason, retryAfter) => {
      this.keyNeeded = reason;
      this.keyRetryAfter = retryAfter;
      this.stopPolling();
    });
  }

  /** The prompt stored a working key (or the hub needs none): reload everything. */
  keyAccepted() {
    this.keyNeeded = null;
    this.keyRetryAfter = null;
    this.hasAccessKey = getAccessKey() != null;
    this.error = "";
    void this.refresh();
  }

  /** Forget the key in this browser; the prompt comes back if the hub wants one. */
  forgetAccessKey() {
    clearAccessKey();
    this.hasAccessKey = false;
    void this.refresh();
  }

  /** The hub's own key setting (`Network › Access key`); null on hubs before 5.3. */
  accessKeyStatus = $state<AccessKeyStatus | null>(null);

  /**
   * Set or replace the hub's access key. The hub validates it like
   * `REKORD_ACCESS_KEY` (length, characters, weak keys); on success this browser
   * keeps the key so the panel goes on working, every other client asks for it.
   */
  async setHubAccessKey(key: string): Promise<boolean> {
    const value = key.trim();
    if (!isWellFormedAccessKey(value)) {
      this.error = t("network.hubKey.malformed");
      return false;
    }
    this.busy = true;
    try {
      this.accessKeyStatus = await api.setHubAccessKey(value);
      setAccessKey(value);
      this.hasAccessKey = true;
      this.error = "";
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Remove the hub's access key: the hub is open again to anyone who reaches it. */
  async clearHubAccessKey() {
    if (!window.confirm(t("network.hubKey.removeConfirm"))) return;
    this.busy = true;
    try {
      this.accessKeyStatus = await api.clearHubAccessKey();
      clearAccessKey();
      this.hasAccessKey = false;
      this.error = "";
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  readonly scanning = $derived(
    Boolean(this.stats?.scanning ?? this.health?.scanning ?? this.diagnostics?.scanning),
  );

  readonly canManage = $derived(this.access?.canManageMachine !== false);

  /**
   * Removal skipped by the mass-deletion guard on the most recent scan:
   * hub meta when served, else the newest of this session's scan and the
   * activity log.
   */
  readonly pruneNotice = $derived.by((): PruneNotice | null => {
    const hub = this.diagnostics?.library;
    if (hub && "lastPruneSkipped" in hub) {
      const reason = hub.lastPruneSkipped?.trim();
      return reason ? { reason, missing: null, source: "hub", at: null } : null;
    }
    const fromScan: PruneNotice | null = this.lastScan?.pruneSkipped
      ? {
          reason: this.lastScan.pruneSkipped,
          missing: this.lastScan.missingTracks ?? null,
          source: "scan",
          at: this.lastScanFinishedAt,
        }
      : null;
    const act = this.activityScan;
    if (!act) return fromScan;
    if (!this.lastScanFinishedAt) return act.notice;
    return Date.parse(act.ts) > Date.parse(this.lastScanFinishedAt) ? act.notice : fromScan;
  });

  /** Favorites / playlist entries waiting for their file (null when the hub does not say). */
  readonly parked = $derived.by(() => {
    const lib = this.diagnostics?.library;
    if (!lib || (lib.parkedFavorites == null && lib.parkedPlaylistTracks == null)) return null;
    return {
      favorites: lib.parkedFavorites ?? 0,
      playlistTracks: lib.parkedPlaylistTracks ?? 0,
    };
  });

  readonly statItems = $derived.by((): StatItem[] => {
    const h = this.health;
    const s = this.stats;
    const version = h?.version ? `v${h.version}` : "";
    const count = (n: number | null | undefined) => (n == null ? "—" : formatNumber(n));
    return [
      { label: t("stats.service"), value: `${h?.service ?? "—"} ${version}`.trim() },
      { label: t("stats.tracks"), value: count(s?.track_count) },
      { label: t("stats.albums"), value: count(s?.album_count) },
      { label: t("stats.artists"), value: count(s?.artist_count) },
      {
        label: t("stats.lastScan"),
        value: this.scanning ? t("stats.scanning") : formatDateTime(s?.last_scan_at),
      },
      { label: t("stats.activeJobs"), value: count(this.diagnostics?.jobs.active ?? 0) },
      {
        label: t("stats.freeSpace"),
        value: formatBytes(
          this.diagnostics?.disk?.availableBytes ?? this.stats?.disk_available_bytes,
        ),
      },
      { label: t("stats.uptime"), value: formatDuration(this.diagnostics?.uptimeSecs) },
    ];
  });

  /** Wrap an action: single busy flag, message on success, error on failure. */
  private async run(fn: () => Promise<string>) {
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      this.message = await fn();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  private fail(e: unknown) {
    // Key refusals open the prompt instead of an error banner.
    if (isApiError(e) && accessKeyReason(e.code)) return;
    this.error = errorText(e);
  }

  async refresh() {
    this.error = "";
    try {
      // Without the key the hub answers a minimal health and refuses the rest.
      const health = await api.health();
      this.health = health;
      if (health.accessKey === "required") {
        this.keyNeeded = getAccessKey() ? "invalid" : "required";
        this.stopPolling();
        return;
      }
      const [stats, path, access] = await Promise.all([
        api.stats(),
        api.getPath(),
        api.machineAccess(),
      ]);
      this.stats = stats;
      this.musicRoot = path.music_root ?? "";
      this.access = access;
      await this.loadSection(this.section);
      if (this.scanning || (this.diagnostics?.jobs.active ?? 0) > 0) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Fetch only what the visible section needs. */
  async loadSection(section: SectionId) {
    try {
      switch (section) {
        case "status":
        case "diagnostics":
          this.diagnostics = await api.diagnostics();
          if (section === "status") await this.loadScanActivity();
          break;
        case "library":
          [this.layout, this.watcher, this.diagnostics, this.embedded] = await Promise.all([
            api.getLayout(),
            api.watch(),
            api.diagnostics(),
            api.embedded().catch(() => null),
          ]);
          await this.loadScanActivity();
          break;
        case "jobs":
          this.jobs = await api.jobs();
          break;
        case "activity":
          await this.loadActivity();
          break;
        case "accounts": {
          const res = await api.accounts();
          this.accounts = res.accounts;
          this.defaultAccountId = res.defaultAccountId;
          break;
        }
        case "integrations":
          this.config = await api.config();
          break;
        case "network":
          [this.remote, this.power, this.accessKeyStatus] = await Promise.all([
            api.remoteAccess(),
            api.power().catch(() => null),
            api.accessKeyStatus().catch(() => null),
          ]);
          break;
        case "backup":
          this.legacy = this.canManage ? await api.legacyImportStatus() : null;
          break;
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * The hub logs "N tracce non trovate ma mantenute: <reason>" when the guard
   * keeps vanished tracks (watcher and startup scans included). The newest
   * `scan` line of today tells whether the last scan skipped the removal.
   * Best effort: a failure here never hides the section.
   */
  private async loadScanActivity() {
    try {
      const log = await api.activityLog({ scope: "system", limit: 200 });
      const last = log.entries.find((e) => e.kind === "scan");
      if (!last) {
        this.activityScan = null;
        return;
      }
      const coded =
        last.code === "scan.pruneSkipped" && typeof last.params?.reason === "string"
          ? { reason: last.params.reason, missing: Number(last.params.missing ?? NaN) }
          : null;
      const m = coded ? null : PRUNE_ACTIVITY_RE.exec(last.message.trim());
      const found = coded ?? (m ? { reason: m[2], missing: Number(m[1]) } : null);
      this.activityScan = {
        ts: last.ts,
        notice: found
          ? {
              reason: found.reason,
              missing: Number.isFinite(found.missing) ? found.missing : null,
              source: "activity",
              at: last.ts,
            }
          : null,
      };
    } catch {
      /* activity is optional context */
    }
  }

  async show(section: SectionId) {
    this.section = section;
    this.message = "";
    this.error = "";
    await this.loadSection(section);
  }

  /** Poll while the hub is indexing or a job is running. */
  startPolling() {
    if (this.pollTimer != null) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 1500);
  }

  stopPolling() {
    if (this.pollTimer == null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll() {
    try {
      this.stats = await api.stats();
      this.diagnostics = await api.diagnostics();
      if (this.section === "jobs") this.jobs = await api.jobs();
      if (this.section === "library") {
        [this.watcher, this.embedded] = await Promise.all([
          api.watch(),
          api.embedded().catch(() => null),
        ]);
      }
      const active = (this.diagnostics?.jobs.active ?? 0) > 0;
      if (!this.scanning && !active) {
        this.stopPolling();
        if (this.section === "library" || this.section === "status") {
          await this.loadScanActivity();
        }
        this.message = t("msg.libraryReady", {
          tracks: tp("count.tracks", this.stats?.track_count ?? 0),
        });
      }
    } catch (e) {
      this.fail(e);
      this.stopPolling();
    }
  }

  savePath() {
    return this.run(async () => {
      await api.setPath(this.musicRoot.trim());
      await this.refresh();
      if (this.scanning) {
        this.startPolling();
        return t("msg.pathSavedIndexing");
      }
      return t("msg.pathSaved");
    });
  }

  runScan(mode: ScanMode) {
    return this.run(async () => {
      try {
        const r = await api.scan(mode);
        this.lastScan = r;
        this.lastScanFinishedAt = new Date().toISOString();
        await this.refresh();
        const parts = [
          tp("msg.scanIndexed", r.indexedTracks),
          tp("msg.scanUnchanged", r.unchanged),
        ];
        if (r.removedTracks > 0) {
          parts.push(tp("msg.scanRemoved", r.removedTracks));
        }
        if (r.pruneSkipped && (r.missingTracks ?? 0) > 0) {
          parts.push(tp("msg.scanKept", r.missingTracks ?? 0));
        }
        return t("msg.scanDone", {
          mode: t(`scan.mode.${r.mode === "full" ? "full" : "incremental"}`),
          details: parts.join(", "),
        });
      } catch (e) {
        // A startup autoscan may already hold the lock, or the request outlived
        // our timer while the hub keeps going: follow it instead of failing.
        const busy = isApiError(e, "http") && e.status === 409;
        if (busy || isApiError(e, "timeout")) {
          this.startPolling();
          await this.refresh();
          return t(busy ? "msg.scanAlreadyRunning" : "msg.scanStillRunning");
        }
        throw e;
      }
    });
  }

  /**
   * A full scan bypasses the mass-deletion guard: every track whose file is
   * not found leaves the catalog. Ask first.
   */
  confirmFullScan() {
    if (!window.confirm(t("scan.confirmFull"))) return Promise.resolve();
    return this.runScan("full");
  }

  runProbe() {
    return this.run(async () => {
      this.probe = await api.probe();
      const best = this.probe.candidates[0];
      return best
        ? t("msg.probeDetected", {
            layout: layoutLabel(best.layout),
            confidence: formatPercent(best.confidence),
          })
        : t("msg.probeNone");
    });
  }

  applyProbeSuggestion() {
    const suggested = this.probe?.suggestedLayout;
    if (!suggested) return Promise.resolve();
    return this.saveLayout(suggested);
  }

  saveLayout(next: Partial<LibraryLayoutConfig>) {
    return this.run(async () => {
      this.layout = await api.setLayout(next);
      return t("msg.layoutSaved");
    });
  }

  setPreferredLayout(preferred: PreferredLayout) {
    if (!this.layout) return Promise.resolve();
    return this.saveLayout({ ...this.layout, preferredLayout: preferred });
  }

  toggleDeepScan(deepScan: boolean) {
    if (!this.layout) return Promise.resolve();
    return this.saveLayout({ ...this.layout, deepScan });
  }

  setWatch(enabled: boolean) {
    return this.run(async () => {
      this.watcher = await api.setWatch(enabled);
      return enabled ? t("msg.watchOn") : t("msg.watchOff");
    });
  }

  setEmbedded(next: { enabled?: boolean; priority?: EmbeddedPriority; embedDownloads?: boolean }) {
    return this.run(async () => {
      this.embedded = await api.setEmbedded(next);
      // Only the reading settings re-read the library.
      if (next.enabled === undefined && next.priority === undefined) return t("msg.downloadTagsSaved");
      this.startPolling();
      return t("msg.embeddedSaved");
    });
  }

  /** "Rileggi metadati incorporati"; `overrideStudio` asks for confirmation. */
  rereadEmbedded(overrideStudio = false) {
    if (overrideStudio && !window.confirm(t("library.embedded.overrideConfirm"))) {
      return Promise.resolve();
    }
    return this.run(async () => {
      this.embedded = await api.rereadEmbedded(overrideStudio);
      this.startPolling();
      return t("msg.embeddedReread");
    });
  }

  rebuildThumbnails() {
    return this.run(async () => {
      await api.rebuildThumbnails();
      this.startPolling();
      return t("msg.thumbsStarted");
    });
  }

  /** Library › Maintenance shortcut: same as the backup section's button. */
  syncLegacyMeta() {
    return this.importLegacy();
  }

  /** Merge legacy RE-KORD data (`.kord`) into the hub, or preview it. */
  importLegacy(opts: { dryRun?: boolean; force?: boolean } = {}) {
    return this.run(async () => {
      const r = await api.legacyImport(opts);
      this.legacyReport = r;
      if (!r.dryRun) await this.refresh();
      if (this.canManage) this.legacy = await api.legacyImportStatus();
      const params = {
        accounts: tp("count.accounts", r.accounts.filter((a) => a.status === "imported").length),
        favorites: tp("count.favorites", r.totals.favorites),
        playlists: tp("count.playlists", r.totals.playlists),
        moods: tp("count.moods", r.totals.moods),
        blocked: tp("count.blocked", r.totals.excludedTracks + r.totals.excludedAlbums),
      };
      return t(r.dryRun ? "msg.legacyPreview" : "msg.legacyImported", params);
    });
  }

  cancelJob(id: string) {
    return this.run(async () => {
      await api.cancelJob(id);
      this.jobs = await api.jobs();
      return t("msg.jobCanceled");
    });
  }

  clearJobs() {
    return this.run(async () => {
      const r = await api.clearJobs();
      this.jobs = await api.jobs();
      return t("msg.jobsCleared", { count: formatNumber(r.removed) });
    });
  }

  clearErrors() {
    return this.run(async () => {
      await api.clearErrors();
      this.diagnostics = await api.diagnostics();
      return t("msg.errorsCleared");
    });
  }

  async loadActivity() {
    try {
      const log = await api.activityLog({
        day: this.activityDay,
        scope: this.activityScope,
        limit: 500,
      });
      this.activity = log.entries;
    } catch (e) {
      this.fail(e);
    }
  }

  createAccount() {
    const name = this.newAccountName.trim();
    if (!name) return Promise.resolve();
    return this.run(async () => {
      const res = await api.createAccount(name);
      this.accounts = res.accounts;
      this.newAccountName = "";
      return t("msg.accountCreated", { name });
    });
  }

  renameAccount(id: string, name: string) {
    return this.run(async () => {
      const res = await api.renameAccount(id, name.trim());
      this.accounts = res.accounts;
      return t("msg.accountRenamed");
    });
  }

  deleteAccount(id: string) {
    return this.run(async () => {
      const res = await api.deleteAccount(id);
      this.accounts = res.accounts;
      return t("msg.accountDeleted");
    });
  }

  exportAccount(id: string) {
    return this.run(async () => {
      await api.exportAccount(id);
      return t("msg.accountExported");
    });
  }

  downloadBackup() {
    return this.run(async () => {
      await api.downloadBackup();
      return t("msg.backupDownloaded");
    });
  }

  restoreBackup(file: File) {
    return this.run(async () => {
      const r = await api.restore(file);
      await this.refresh();
      if (r.themeOnly) return t("msg.themeImported");
      return t("msg.backupRestored", {
        version: r.version ?? "?",
        tracks: tp("count.tracks", r.scanned_tracks ?? 0),
        favorites: tp("count.favorites", r.favorites ?? 0),
        playlists: tp("count.playlists", r.playlists ?? 0),
      });
    });
  }

  uploadCookies(file: File) {
    return this.run(async () => {
      this.config = await api.uploadCookies(file);
      return t("msg.cookiesUploaded");
    });
  }

  clearCookies() {
    return this.run(async () => {
      this.config = await api.clearCookies();
      return t("msg.cookiesRemoved");
    });
  }

  saveDiscogsToken() {
    const token = this.discogsToken.trim();
    if (!token) return Promise.resolve();
    return this.run(async () => {
      this.config = await api.setDiscogsToken(token);
      this.discogsToken = "";
      return t("msg.discogsSaved");
    });
  }

  clearDiscogsToken() {
    return this.run(async () => {
      this.config = await api.clearDiscogsToken();
      return t("msg.discogsRemoved");
    });
  }

  remoteStart() {
    return this.run(async () => {
      this.remote = await api.remoteStart();
      return this.remote.publicUrl
        ? t("msg.tunnelRunning", { url: this.remote.publicUrl })
        : t("msg.tunnelStarting");
    });
  }

  remoteStop() {
    return this.run(async () => {
      this.remote = await api.remoteStop();
      return t("msg.tunnelStopped");
    });
  }

  remoteLogin() {
    return this.run(async () => {
      const r = await api.remoteLogin();
      window.open(r.loginUrl, "_blank", "noopener");
      this.remote = await api.remoteAccess();
      return r.note || t("msg.cloudflareLogin");
    });
  }

  remoteLogout() {
    return this.run(async () => {
      this.remote = await api.remoteLogout();
      return t("msg.cloudflareLogout");
    });
  }

  loadPublicIp() {
    return this.run(async () => {
      const r = await api.publicIp();
      this.publicIp = r.ip;
      return r.ip ? t("msg.publicIp", { ip: r.ip }) : t("msg.publicIpNone");
    });
  }

  /** Change sleep prevention; the hub applies it at once. */
  setPower(patch: PowerPatch) {
    return this.run(async () => {
      this.power = await api.setPower(patch);
      if (patch.preventSleep) return t(`power.msg.${patch.preventSleep}`);
      return t("power.msg.saved");
    });
  }

  async loadPower() {
    try {
      this.power = await api.power();
    } catch (e) {
      this.fail(e);
    }
  }

  setRemoteAdmin(enabled: boolean) {
    return this.run(async () => {
      this.access = await api.setRemoteAdmin(enabled);
      return enabled ? t("msg.remoteAdminOn") : t("msg.remoteAdminOff");
    });
  }

  /** Feedback for actions that do not hit the hub (copy to clipboard…). */
  notify(message: string, isError = false) {
    this.message = isError ? "" : message;
    this.error = isError ? message : "";
  }
}

export const admin = new AdminSession();
