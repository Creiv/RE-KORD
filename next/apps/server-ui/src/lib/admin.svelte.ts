import { api, type LibraryStats } from "../api";
import type { StatItem } from "@rekord/ui";

class AdminSession {
  health = $state<Record<string, unknown> | null>(null);
  stats = $state<LibraryStats | null>(null);
  musicRoot = $state("");
  busy = $state(false);
  message = $state("");
  error = $state("");

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly statItems = $derived.by((): StatItem[] => {
    const h = this.health;
    const s = this.stats;
    const version = h?.version ? `v${h.version}` : "";
    const scanning = Boolean(s?.scanning ?? h?.scanning);
    return [
      { label: "Servizio", value: `${h?.service ?? "—"} ${version}`.trim() },
      { label: "Brani", value: s?.track_count ?? "—" },
      { label: "Album", value: s?.album_count ?? "—" },
      { label: "Artisti", value: s?.artist_count ?? "—" },
      { label: "Ultimo scan", value: scanning ? "in corso…" : (s?.last_scan_at ?? "mai") },
    ];
  });

  async refresh() {
    this.error = "";
    try {
      this.health = await api.health();
      this.stats = await api.stats();
      const path = await api.getPath();
      this.musicRoot = path.music_root ?? "";
      const scanning = Boolean(this.stats?.scanning ?? this.health?.scanning);
      if (scanning) {
        this.message = "Indicizzazione libreria in corso…";
        this.startPolling();
      } else if (this.pollTimer != null) {
        const n = this.stats?.track_count ?? 0;
        this.message =
          n > 0
            ? `Libreria pronta: ${n} brani.`
            : "Indicizzazione terminata.";
        this.stopPolling();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Poll while the hub is indexing (startup autoscan or long scan). */
  startPolling() {
    if (this.pollTimer != null) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 1000);
  }

  stopPolling() {
    if (this.pollTimer == null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async savePath() {
    this.busy = true;
    this.message = "";
    this.error = "";
    try {
      await api.setPath(this.musicRoot.trim());
      this.message = "Percorso salvato.";
      await this.refresh();
      // Autoscan may have started after first path save.
      if (this.stats?.scanning || this.health?.scanning) {
        this.message = "Percorso salvato — indicizzazione avviata…";
        this.startPolling();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  async runScan() {
    this.busy = true;
    this.message = "";
    this.error = "";
    try {
      const report = await api.scan();
      this.message = `Scan: ${report.indexed_tracks} brani indicizzati (${report.scanned_files} file).`;
      await this.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Concurrent with startup autoscan: poll until done instead of failing hard.
      if (/already in progress|Conflict/i.test(msg)) {
        this.message = "Scan già in corso — attendo…";
        this.startPolling();
        await this.refresh();
      } else {
        this.error = msg;
      }
    } finally {
      this.busy = false;
    }
  }
}

export const admin = new AdminSession();
