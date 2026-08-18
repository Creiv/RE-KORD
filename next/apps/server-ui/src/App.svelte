<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, BrandMark, NavButton } from "@rekord/ui";
  import { admin, SECTIONS } from "./lib/admin.svelte";
  import AccountsPanel from "./views/AccountsPanel.svelte";
  import ActivityPanel from "./views/ActivityPanel.svelte";
  import BackupPanel from "./views/BackupPanel.svelte";
  import DiagnosticsPanel from "./views/DiagnosticsPanel.svelte";
  import IntegrationsPanel from "./views/IntegrationsPanel.svelte";
  import JobsPanel from "./views/JobsPanel.svelte";
  import LibraryPanel from "./views/LibraryPanel.svelte";
  import NetworkPanel from "./views/NetworkPanel.svelte";
  import StatusPanel from "./views/StatusPanel.svelte";

  const SECTION_LEDE: Record<string, string> = {
    status: "Come sta l'hub in questo momento.",
    library: "Cartella musica, struttura, aggiornamento automatico e manutenzione.",
    jobs: "Scansioni, miniature e ripristini in corso.",
    diagnostics: "Versioni, spazio, programmi esterni e ultimi errori.",
    activity: "Cosa è successo sull'hub, giorno per giorno.",
    backup: "Copie di sicurezza e ripristino, anche dai backup della versione precedente.",
    accounts: "Chi usa questo hub e con quali dati personali.",
    integrations: "Credenziali per download e metadati.",
    network: "Indirizzi, tunnel e chi può comandare l'hub.",
  };

  const version = $derived(admin.health?.version ?? admin.diagnostics?.version ?? "");
  const current = $derived(SECTIONS.find((s) => s.id === admin.section));

  onMount(() => {
    void admin.refresh();
    return () => admin.stopPolling();
  });
</script>

<div class="shell" data-theme="server">
  <aside class="rail">
    <BrandMark eyebrow={version ? `Hub ${version}` : "Hub"} title="RE-KORD" size="sm" />
    <nav class="nav">
      {#each SECTIONS as section (section.id)}
        <NavButton
          label={section.label}
          active={admin.section === section.id}
          onclick={() => void admin.show(section.id)}
        />
      {/each}
    </nav>
    {#if admin.access && !admin.access.canManageMachine}
      <p class="rail-note">Sola lettura: comandi disponibili dal computer dell'hub.</p>
    {/if}
  </aside>

  <main class="page">
    <header class="head">
      <h1>{current?.label ?? "Hub"}</h1>
      <p>{SECTION_LEDE[admin.section] ?? ""}</p>
    </header>

    {#if admin.error}
      <Banner tone="error">{admin.error}</Banner>
    {/if}
    {#if admin.message}
      <Banner tone="ok">{admin.message}</Banner>
    {/if}

    {#if admin.section === "status"}
      <StatusPanel
        items={admin.statItems}
        busy={admin.busy}
        onrefresh={() => void admin.refresh()}
      />
    {:else if admin.section === "library"}
      <LibraryPanel
        bind:musicRoot={admin.musicRoot}
        busy={admin.busy}
        onsave={() => void admin.savePath()}
      />
    {:else if admin.section === "jobs"}
      <JobsPanel />
    {:else if admin.section === "diagnostics"}
      <DiagnosticsPanel />
    {:else if admin.section === "activity"}
      <ActivityPanel />
    {:else if admin.section === "backup"}
      <BackupPanel />
    {:else if admin.section === "accounts"}
      <AccountsPanel />
    {:else if admin.section === "integrations"}
      <IntegrationsPanel />
    {:else if admin.section === "network"}
      <NetworkPanel />
    {/if}
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    gap: 1.5rem;
    max-width: 68rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    align-items: start;
  }

  .rail {
    position: sticky;
    top: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .rail-note {
    margin: 0;
    font-size: var(--rk-fs-xs);
    line-height: var(--rk-lh);
    color: var(--rk-muted);
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: var(--rk-section-gap);
    min-width: 0;
  }

  .head h1 {
    margin: 0 0 0.25rem;
    font-size: var(--rk-fs-2xl);
    font-weight: 800;
    letter-spacing: -0.03em;
  }

  .head p {
    margin: 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-md);
    line-height: var(--rk-lh);
  }

  @media (max-width: 899.98px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
      gap: 1.1rem;
      padding: 1.25rem 1rem 3rem;
    }

    .rail {
      position: static;
    }

    .nav {
      flex-direction: row;
      overflow-x: auto;
      gap: 0.3rem;
      padding-bottom: 0.2rem;
    }

    .nav :global(.rk-nav) {
      width: auto;
      white-space: nowrap;
    }
  }
</style>
