<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, PageHeader } from "@rekord/ui";
  import { admin } from "./lib/admin.svelte";
  import LibraryPanel from "./views/LibraryPanel.svelte";
  import StatusPanel from "./views/StatusPanel.svelte";

  onMount(() => {
    void admin.refresh();
    return () => admin.stopPolling();
  });
</script>

<main class="page" data-theme="server">
  <PageHeader
    eyebrow="Server 5.1.0"
    title="RE-KORD"
    lede="Pannello minimo: stato hub, percorso libreria e scan. Il player vive nel client."
  />

  {#if admin.error}
    <Banner tone="error">{admin.error}</Banner>
  {/if}
  {#if admin.message}
    <Banner tone="ok">{admin.message}</Banner>
  {/if}

  <StatusPanel
    items={admin.statItems}
    busy={admin.busy}
    onrefresh={() => void admin.refresh()}
  />

  <LibraryPanel
    bind:musicRoot={admin.musicRoot}
    busy={admin.busy}
    onsave={() => void admin.savePath()}
    onscan={() => void admin.runScan()}
  />
</main>

<style>
  .page {
    max-width: 640px;
    margin: 0 auto;
    padding: 3rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: var(--rk-section-gap);
    min-width: 0;
  }

  .page > :global(.rk-page-header),
  .page > :global(.rk-banner),
  .page > :global(.rk-panel) {
    margin-bottom: 0;
  }
</style>
