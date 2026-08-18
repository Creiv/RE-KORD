<script lang="ts">
  import { ActionRow, Button, Panel, StatList, type StatItem } from "@rekord/ui";
  import { admin, humanBytes, humanTime } from "../lib/admin.svelte";

  let {
    items = [],
    busy = false,
    onrefresh,
  }: {
    items?: StatItem[];
    busy?: boolean;
    onrefresh: () => void;
  } = $props();

  const diag = $derived(admin.diagnostics);
</script>

<Panel title="Stato">
  {#snippet actions()}
    <Button variant="secondary" disabled={busy} onclick={onrefresh}>Aggiorna</Button>
  {/snippet}

  <StatList {items} />

  {#if diag}
    <div class="grid">
      <div class="cell">
        <span class="k">Cartella musica</span>
        <span class="v">{diag.musicRoot ?? "non impostata"}</span>
      </div>
      <div class="cell">
        <span class="k">Dati hub</span>
        <span class="v">{diag.dataDir}</span>
      </div>
      <div class="cell">
        <span class="k">Database</span>
        <span class="v">{humanBytes(diag.db.sizeBytes)}</span>
      </div>
      <div class="cell">
        <span class="k">Osservazione cartella</span>
        <span class="v">
          {diag.watcher.running
            ? `attiva${diag.watcher.pending ? " (aggiornamento in coda)" : ""}`
            : !diag.watcher.enabled
              ? "disattivata"
              : diag.musicRoot
                ? "attivata, in avvio"
                : "in attesa della cartella musica"}
        </span>
      </div>
      <div class="cell">
        <span class="k">Download attivi</span>
        <span class="v">{diag.activeDownloads}</span>
      </div>
      <div class="cell">
        <span class="k">Ultimo evento cartella</span>
        <span class="v">{humanTime(diag.watcher.lastEventAt)}</span>
      </div>
    </div>
  {/if}

  <ActionRow>
    <Button
      variant="secondary"
      disabled={busy || !admin.canManage}
      onclick={() => void admin.runScan("incremental")}
    >
      Aggiorna libreria
    </Button>
    <Button variant="ghost" onclick={() => void admin.show("jobs")}>Vedi job</Button>
    <Button variant="ghost" onclick={() => void admin.show("diagnostics")}>
      Diagnostica
    </Button>
  </ActionRow>
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.55rem 1.1rem;
    margin: 0.85rem 0;
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
</style>
