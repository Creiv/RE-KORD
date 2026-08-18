<script lang="ts">
  import { Button, EmptyState, Panel } from "@rekord/ui";
  import { admin, humanBytes, humanDuration, humanTime } from "../lib/admin.svelte";

  const diag = $derived(admin.diagnostics);

  function binaryLine(b?: { available: boolean; path?: string | null; version?: string | null }) {
    if (!b) return "—";
    if (!b.available) return "non trovato";
    return b.version || b.path || "disponibile";
  }
</script>

<Panel title="Diagnostica">
  {#snippet actions()}
    <Button
      variant="secondary"
      disabled={admin.busy}
      onclick={() => void admin.loadSection("diagnostics")}
    >
      Aggiorna
    </Button>
  {/snippet}

  {#if diag}
    <div class="grid">
      <div class="cell">
        <span class="k">Versione hub</span><span class="v">{diag.version}</span>
      </div>
      <div class="cell">
        <span class="k">Attivo da</span>
        <span class="v">{humanDuration(diag.uptimeSecs)}</span>
      </div>
      <div class="cell">
        <span class="k">Database</span>
        <span class="v">{humanBytes(diag.db.sizeBytes)}</span>
      </div>
      <div class="cell">
        <span class="k">Ultimo scan</span>
        <span class="v">{humanTime(diag.db.lastScanAt)}</span>
      </div>
      <div class="cell">
        <span class="k">Spazio disco</span>
        <span class="v">
          {humanBytes(diag.disk?.availableBytes)} liberi su
          {humanBytes(diag.disk?.totalBytes)}
        </span>
      </div>
      <div class="cell">
        <span class="k">Struttura libreria</span>
        <span class="v">{diag.layout?.preferredLayout ?? "—"}</span>
      </div>
      <div class="cell">
        <span class="k">yt-dlp</span><span class="v">{binaryLine(diag.binaries.ytdlp)}</span>
      </div>
      <div class="cell">
        <span class="k">ffmpeg</span><span class="v">{binaryLine(diag.binaries.ffmpeg)}</span>
      </div>
      <div class="cell">
        <span class="k">ffprobe</span><span class="v">{binaryLine(diag.binaries.ffprobe)}</span>
      </div>
      <div class="cell">
        <span class="k">cloudflared</span>
        <span class="v">
          {diag.binaries.cloudflared.available ? "disponibile" : "non trovato"}
        </span>
      </div>
    </div>
  {:else}
    <EmptyState message="Diagnostica non disponibile" />
  {/if}
</Panel>

<Panel title="Ultimi errori">
  {#snippet actions()}
    <Button
      variant="ghost"
      disabled={admin.busy || (diag?.errors.count ?? 0) === 0}
      onclick={() => void admin.clearErrors()}
    >
      Azzera
    </Button>
  {/snippet}

  {#if !diag || diag.errors.recent.length === 0}
    <EmptyState message="Nessun errore registrato" />
  {:else}
    <p class="count">{diag.errors.count} in totale, ultimi {diag.errors.recent.length}:</p>
    <ul class="errors">
      {#each diag.errors.recent as e}
        <li>
          <span class="lvl" data-level={e.level.toLowerCase()}>{e.level}</span>
          <span class="msg">{e.message}</span>
          <span class="src">{e.target} · {humanTime(e.ts)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.55rem 1.1rem;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .k {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .v {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .count {
    margin: 0 0 0.6rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }

  .errors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .errors li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.6rem;
    border-left: 2px solid var(--rk-line);
    padding-left: 0.6rem;
    min-width: 0;
  }

  .lvl {
    font-size: var(--rk-fs-2xs);
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--rk-muted);
  }

  .lvl[data-level="error"] {
    color: #f87171;
  }

  .lvl[data-level="warn"] {
    color: #fbbf24;
  }

  .msg {
    overflow-wrap: anywhere;
  }

  .src {
    grid-column: 2;
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    overflow-wrap: anywhere;
  }
</style>
