<script lang="ts">
  import { ActionRow, Banner, Button, Panel } from "@rekord/ui";
  import { api } from "../api";
  import { admin } from "../lib/admin.svelte";

  let fileInput = $state<HTMLInputElement | null>(null);

  const locked = $derived(admin.busy || !admin.canManage);

  function pickFile() {
    fileInput?.click();
  }

  function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void admin.restoreBackup(file);
  }
</script>

<Panel title="Backup">
  <p class="hint">
    Il backup contiene impostazioni, account, preferiti, playlist e i metadati
    della libreria. I file audio non sono inclusi: restano nella cartella musica.
  </p>
  <ActionRow>
    <Button variant="secondary" onclick={() => window.open(api.backupUrl(), "_blank")}>
      Scarica backup
    </Button>
    <Button disabled={locked} onclick={pickFile}>Ripristina da file ZIP…</Button>
  </ActionRow>
  <input
    bind:this={fileInput}
    class="hidden-file"
    type="file"
    accept=".zip,application/zip"
    onchange={onPicked}
  />
  {#if !admin.canManage}
    <Banner tone="info">
      Il ripristino si esegue dal computer dell'hub con l'account Default.
    </Banner>
  {/if}
</Panel>

<Panel title="Ripristino da versione precedente">
  <p class="hint">
    I backup della versione React (v2) sono riconosciuti automaticamente: vengono
    importati account, preferiti, playlist e metadati, poi la libreria viene
    reindicizzata. Serve che la cartella musica esista già sul disco.
  </p>
  <ActionRow>
    <Button
      variant="ghost"
      disabled={locked}
      onclick={() => void admin.syncLegacyMeta()}
    >
      Importa metadati da .kord
    </Button>
  </ActionRow>
</Panel>

<style>
  .hint {
    margin: 0 0 0.8rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .hidden-file {
    display: none;
  }
</style>
