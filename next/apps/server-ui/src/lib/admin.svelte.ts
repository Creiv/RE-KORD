import {
  api,
  type Account,
  type ActivityEntry,
  type Diagnostics,
  type Health,
  type HubConfig,
  type JobEntry,
  type LibraryLayoutConfig,
  type LibraryProbeReport,
  type LibraryStats,
  type MachineAccess,
  type PreferredLayout,
  type RemoteAccessState,
  type ScanMode,
  type WatcherStatus,
} from "../api";
import type { StatItem } from "@rekord/ui";

export type SectionId =
  | "status"
  | "library"
  | "jobs"
  | "diagnostics"
  | "activity"
  | "backup"
  | "accounts"
  | "integrations"
  | "network";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "status", label: "Stato" },
  { id: "library", label: "Libreria" },
  { id: "jobs", label: "Job" },
  { id: "diagnostics", label: "Diagnostica" },
  { id: "activity", label: "Attività" },
  { id: "backup", label: "Backup" },
  { id: "accounts", label: "Account" },
  { id: "integrations", label: "Integrazioni" },
  { id: "network", label: "Rete" },
];

/** Bytes → human size, used for disk and DB figures. */
export function humanBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function humanTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function humanDuration(secs?: number | null): string {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.trunc(secs));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}g ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${s % 60}s`;
  return `${s}s`;
}

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

  busy = $state(false);
  message = $state("");
  error = $state("");

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly scanning = $derived(
    Boolean(this.stats?.scanning ?? this.health?.scanning ?? this.diagnostics?.scanning),
  );

  readonly canManage = $derived(this.access?.canManageMachine !== false);

  readonly statItems = $derived.by((): StatItem[] => {
    const h = this.health;
    const s = this.stats;
    const version = h?.version ? `v${h.version}` : "";
    return [
      { label: "Servizio", value: `${h?.service ?? "—"} ${version}`.trim() },
      { label: "Brani", value: s?.track_count ?? "—" },
      { label: "Album", value: s?.album_count ?? "—" },
      { label: "Artisti", value: s?.artist_count ?? "—" },
      {
        label: "Ultimo scan",
        value: this.scanning ? "in corso…" : humanTime(s?.last_scan_at),
      },
      { label: "Job attivi", value: this.diagnostics?.jobs.active ?? 0 },
      {
        label: "Spazio libero",
        value: humanBytes(
          this.diagnostics?.disk?.availableBytes ?? this.stats?.disk_available_bytes,
        ),
      },
      { label: "Attivo da", value: humanDuration(this.diagnostics?.uptimeSecs) },
    ];
  });

  /** Wrap an action: single busy flag, message on success, error on failure. */
  private async run(label: string, fn: () => Promise<string | void>) {
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      const msg = await fn();
      this.message = msg || label;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
  }

  async refresh() {
    this.error = "";
    try {
      const [health, stats, path, access] = await Promise.all([
        api.health(),
        api.stats(),
        api.getPath(),
        api.machineAccess(),
      ]);
      this.health = health;
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
          break;
        case "library":
          [this.layout, this.watcher] = await Promise.all([
            api.getLayout(),
            api.watch(),
          ]);
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
          this.remote = await api.remoteAccess();
          break;
        case "backup":
          break;
      }
    } catch (e) {
      this.fail(e);
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
      if (this.section === "library") this.watcher = await api.watch();
      const active = (this.diagnostics?.jobs.active ?? 0) > 0;
      if (!this.scanning && !active) {
        this.stopPolling();
        this.message = `Libreria pronta: ${this.stats?.track_count ?? 0} brani.`;
      }
    } catch (e) {
      this.fail(e);
      this.stopPolling();
    }
  }

  savePath() {
    return this.run("Percorso salvato.", async () => {
      await api.setPath(this.musicRoot.trim());
      await this.refresh();
      if (this.scanning) {
        this.startPolling();
        return "Percorso salvato — indicizzazione avviata…";
      }
      return "Percorso salvato.";
    });
  }

  runScan(mode: ScanMode) {
    return this.run("Scan avviato.", async () => {
      try {
        const r = await api.scan(mode);
        await this.refresh();
        const pruned = r.removedTracks + r.removedAlbums + r.removedArtists;
        return `Scan ${r.mode}: ${r.indexedTracks} indicizzati, ${r.unchanged} invariati${
          pruned > 0 ? `, ${r.removedTracks} rimossi` : ""
        }.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A startup autoscan may already hold the lock: follow it instead of failing.
        if (/already in progress|in corso|Conflict/i.test(msg)) {
          this.startPolling();
          await this.refresh();
          return "Scan già in corso — attendo…";
        }
        throw e;
      }
    });
  }

  runProbe() {
    return this.run("Struttura analizzata.", async () => {
      this.probe = await api.probe();
      const best = this.probe.candidates[0];
      return best
        ? `Struttura rilevata: ${best.layout} (${Math.round(best.confidence * 100)}%).`
        : "Nessuna struttura riconosciuta.";
    });
  }

  applyProbeSuggestion() {
    const suggested = this.probe?.suggestedLayout;
    if (!suggested) return Promise.resolve();
    return this.saveLayout(suggested);
  }

  saveLayout(next: Partial<LibraryLayoutConfig>) {
    return this.run("Layout salvato.", async () => {
      this.layout = await api.setLayout(next);
      return "Layout salvato.";
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
    return this.run("Watcher aggiornato.", async () => {
      this.watcher = await api.setWatch(enabled);
      return enabled
        ? "Watcher attivo: la libreria si aggiorna da sola."
        : "Watcher disattivato.";
    });
  }

  rebuildThumbnails() {
    return this.run("Miniature in rigenerazione.", async () => {
      await api.rebuildThumbnails();
      this.startPolling();
      return "Rigenerazione miniature avviata.";
    });
  }

  syncLegacyMeta() {
    return this.run("Sincronizzazione legacy avviata.", async () => {
      const r = await api.syncLegacyMeta();
      await this.refresh();
      return `Metadati legacy importati: ${r.album_meta_merged ?? 0} album, ${
        r.track_meta_merged ?? 0
      } brani.`;
    });
  }

  cancelJob(id: string) {
    return this.run("Job annullato.", async () => {
      await api.cancelJob(id);
      this.jobs = await api.jobs();
      return "Job annullato.";
    });
  }

  clearJobs() {
    return this.run("Storico job pulito.", async () => {
      const r = await api.clearJobs();
      this.jobs = await api.jobs();
      return `Rimossi ${r.removed} job conclusi.`;
    });
  }

  clearErrors() {
    return this.run("Errori azzerati.", async () => {
      await api.clearErrors();
      this.diagnostics = await api.diagnostics();
      return "Buffer errori azzerato.";
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
    return this.run("Account creato.", async () => {
      const res = await api.createAccount(name);
      this.accounts = res.accounts;
      this.newAccountName = "";
      return `Account “${name}” creato.`;
    });
  }

  renameAccount(id: string, name: string) {
    return this.run("Account rinominato.", async () => {
      const res = await api.renameAccount(id, name.trim());
      this.accounts = res.accounts;
      return "Account rinominato.";
    });
  }

  deleteAccount(id: string) {
    return this.run("Account eliminato.", async () => {
      const res = await api.deleteAccount(id);
      this.accounts = res.accounts;
      return "Account eliminato.";
    });
  }

  restoreBackup(file: File) {
    return this.run("Backup ripristinato.", async () => {
      const r = await api.restore(file);
      await this.refresh();
      if (r.themeOnly) return "Tema importato.";
      return `Backup v${r.version ?? "?"} ripristinato: ${r.scanned_tracks ?? 0} brani, ${
        r.favorites ?? 0
      } preferiti, ${r.playlists ?? 0} playlist.`;
    });
  }

  uploadCookies(file: File) {
    return this.run("Cookie caricati.", async () => {
      this.config = await api.uploadCookies(file);
      return "Cookie YouTube caricati.";
    });
  }

  clearCookies() {
    return this.run("Cookie rimossi.", async () => {
      this.config = await api.clearCookies();
      return "Cookie YouTube rimossi.";
    });
  }

  saveDiscogsToken() {
    const token = this.discogsToken.trim();
    if (!token) return Promise.resolve();
    return this.run("Token salvato.", async () => {
      this.config = await api.setDiscogsToken(token);
      this.discogsToken = "";
      return "Token Discogs salvato.";
    });
  }

  clearDiscogsToken() {
    return this.run("Token rimosso.", async () => {
      this.config = await api.clearDiscogsToken();
      return "Token Discogs rimosso.";
    });
  }

  remoteStart() {
    return this.run("Tunnel avviato.", async () => {
      this.remote = await api.remoteStart();
      return this.remote.publicUrl
        ? `Tunnel attivo: ${this.remote.publicUrl}`
        : "Tunnel in avvio…";
    });
  }

  remoteStop() {
    return this.run("Tunnel fermato.", async () => {
      this.remote = await api.remoteStop();
      return "Tunnel fermato.";
    });
  }

  remoteLogin() {
    return this.run("Login Cloudflare registrato.", async () => {
      const r = await api.remoteLogin();
      window.open(r.loginUrl, "_blank", "noopener");
      this.remote = await api.remoteAccess();
      return r.note;
    });
  }

  remoteLogout() {
    return this.run("Logout Cloudflare eseguito.", async () => {
      this.remote = await api.remoteLogout();
      return "Logout Cloudflare eseguito.";
    });
  }

  loadPublicIp() {
    return this.run("IP pubblico letto.", async () => {
      const r = await api.publicIp();
      this.publicIp = r.ip;
      return r.ip ? `IP pubblico: ${r.ip}` : "IP pubblico non disponibile.";
    });
  }

  setRemoteAdmin(enabled: boolean) {
    return this.run("Accesso remoto aggiornato.", async () => {
      this.access = await api.setRemoteAdmin(enabled);
      return enabled
        ? "Le operazioni di macchina sono ora consentite anche da remoto."
        : "Le operazioni di macchina sono limitate a questo computer.";
    });
  }
}

export const admin = new AdminSession();
