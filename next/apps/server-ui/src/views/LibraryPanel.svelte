<script lang="ts">
  import {
    ActionRow,
    Banner,
    Button,
    Field,
    Panel,
    Select,
    TextInput,
  } from "@rekord/ui";
  import type { PreferredLayout } from "../api";
  import { admin, humanTime } from "../lib/admin.svelte";

  let {
    musicRoot = $bindable(""),
    busy = false,
    onsave,
  }: {
    musicRoot?: string;
    busy?: boolean;
    onsave: () => void;
  } = $props();

  const layoutOptions = [
    { value: "artist/album/track", label: "Artista / Album / Brano" },
    { value: "artist/track", label: "Artista / Brano" },
    { value: "flat", label: "Cartella unica" },
    { value: "tags", label: "Solo tag dei file" },
  ];

  const layout = $derived(admin.layout);
  const watcher = $derived(admin.watcher);
  const probe = $derived(admin.probe);
  const locked = $derived(busy || !admin.canManage);
</script>

<Panel title="Cartella musica">
  <Field label="Percorso sul computer dell'hub">
    <TextInput bind:value={musicRoot} placeholder="/percorso/della/Musica" />
  </Field>
  <ActionRow>
    <Button disabled={locked || !musicRoot.trim()} onclick={onsave}>Salva percorso</Button>
    <Button
      variant="secondary"
      disabled={locked}
      onclick={() => void admin.runScan("incremental")}
    >
      Aggiorna (solo modifiche)
    </Button>
    <Button
      variant="ghost"
      disabled={locked}
      onclick={() => void admin.runScan("full")}
    >
      Ricostruisci tutto
    </Button>
  </ActionRow>
  <p class="hint">
    L'aggiornamento rilegge solo i file nuovi o modificati e rimuove dal catalogo
    quelli spariti dal disco. La ricostruzione completa rilegge ogni file: serve
    dopo una modifica massiccia dei tag.
  </p>
</Panel>

<Panel title="Struttura della libreria">
  {#snippet actions()}
    <Button variant="secondary" disabled={busy} onclick={() => void admin.runProbe()}>
      Analizza cartelle
    </Button>
  {/snippet}

  {#if layout}
    <Field label="Come sono organizzate le cartelle">
      <Select
        options={layoutOptions}
        value={layout.preferredLayout}
        disabled={locked}
        onchange={(e) =>
          void admin.setPreferredLayout(
            (e.currentTarget as HTMLSelectElement).value as PreferredLayout,
          )}
      />
    </Field>
    <label class="check">
      <input
        type="checkbox"
        checked={layout.deepScan}
        disabled={locked}
        onchange={(e) => void admin.toggleDeepScan(e.currentTarget.checked)}
      />
      <span>
        Tratta ogni sottocartella come album separato (CD1, CD2, Bonus…)
      </span>
    </label>
    <p class="hint">
      Con l'opzione disattivata i brani nelle sottocartelle restano nello stesso
      album della cartella principale. Brani senza artista o album finiscono
      sotto “{layout.virtualArtist}” e “{layout.virtualAlbum}”.
    </p>
  {:else}
    <p class="hint">Imposta prima la cartella musica.</p>
  {/if}

  {#if probe}
    <div class="probe">
      <p class="probe-line">
        {probe.stats.estimatedTracks} brani stimati, {probe.stats.dirsAtRoot} cartelle
        principali, profondità massima {probe.stats.maxDepth}.
      </p>
      <ul class="cands">
        {#each probe.candidates as c}
          <li>
            <strong>{c.layout}</strong>
            <span class="pct">{Math.round(c.confidence * 100)}%</span>
            <span class="why">{c.reason}</span>
          </li>
        {/each}
      </ul>
      {#each probe.warnings as w}
        <Banner tone="info">{w}</Banner>
      {/each}
      {#if probe.suggestedLayout.preferredLayout !== layout?.preferredLayout}
        <ActionRow>
          <Button
            disabled={locked}
            onclick={() => void admin.applyProbeSuggestion()}
          >
            Usa la struttura suggerita
          </Button>
        </ActionRow>
      {/if}
    </div>
  {/if}
</Panel>

<Panel title="Aggiornamento automatico">
  {#if watcher}
    <label class="check">
      <input
        type="checkbox"
        checked={watcher.enabled}
        disabled={locked}
        onchange={(e) => void admin.setWatch(e.currentTarget.checked)}
      />
      <span>Osserva la cartella e aggiorna la libreria da sola</span>
    </label>
    <div class="grid">
      <div class="cell">
        <span class="k">Stato</span>
        <span class="v">
          {watcher.running
            ? "in ascolto"
            : !watcher.enabled
              ? "spento"
              : musicRoot.trim()
                ? "in avvio"
                : "in attesa della cartella"}
        </span>
      </div>
      <div class="cell">
        <span class="k">Modifiche viste</span>
        <span class="v">{watcher.events}</span>
      </div>
      <div class="cell">
        <span class="k">Ultima modifica</span>
        <span class="v">{humanTime(watcher.lastEventAt)}</span>
      </div>
      <div class="cell">
        <span class="k">Ultimo aggiornamento</span>
        <span class="v">{humanTime(watcher.lastScanAt)}</span>
      </div>
    </div>
    {#if watcher.error}
      <Banner tone="error">{watcher.error}</Banner>
    {/if}
  {/if}
</Panel>

<Panel title="Manutenzione">
  <ActionRow>
    <Button
      variant="secondary"
      disabled={locked}
      onclick={() => void admin.rebuildThumbnails()}
    >
      Rigenera miniature copertine
    </Button>
    <Button
      variant="ghost"
      disabled={locked}
      onclick={() => void admin.syncLegacyMeta()}
    >
      Importa metadati dalla versione precedente
    </Button>
  </ActionRow>
  <p class="hint">
    Le miniature accelerano le griglie del client. L'importazione legge
    <code>.kord</code> nella cartella musica e riempie solo i campi vuoti.
  </p>
</Panel>

<style>
  .hint {
    margin: 0.6rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    margin: 0.7rem 0 0;
    line-height: var(--rk-lh);
  }

  .check input {
    margin-top: 0.2rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.55rem 1.1rem;
    margin: 0.85rem 0 0;
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

  .probe {
    margin-top: 0.9rem;
  }

  .probe-line {
    margin: 0 0 0.5rem;
    font-size: var(--rk-fs-md);
  }

  .cands {
    margin: 0 0 0.6rem;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .cands li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: var(--rk-fs-sm);
  }

  .pct {
    color: var(--rk-accent);
    font-variant-numeric: tabular-nums;
  }

  .why {
    color: var(--rk-muted);
  }
</style>
