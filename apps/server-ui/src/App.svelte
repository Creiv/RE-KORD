<script lang="ts">
  import { onMount } from "svelte";
  import { Banner, BrandMark, NavButton, Select } from "@rekord/ui";
  import { admin, SECTIONS } from "./lib/admin.svelte";
  import { ADMIN_LOCALES } from "./lib/locale";
  import { i18n, t } from "./lib/i18n.svelte";
  import AccessKeyPrompt from "./views/AccessKeyPrompt.svelte";
  import AccountsPanel from "./views/AccountsPanel.svelte";
  import ActivityPanel from "./views/ActivityPanel.svelte";
  import BackupPanel from "./views/BackupPanel.svelte";
  import DiagnosticsPanel from "./views/DiagnosticsPanel.svelte";
  import IntegrationsPanel from "./views/IntegrationsPanel.svelte";
  import JobsPanel from "./views/JobsPanel.svelte";
  import LibraryPanel from "./views/LibraryPanel.svelte";
  import NetworkPanel from "./views/NetworkPanel.svelte";
  import PodcastsPanel from "./views/PodcastsPanel.svelte";
  import StatusPanel from "./views/StatusPanel.svelte";

  // The logo is a few KB now: cheap enough for the rail (served under /admin/).
  const logoUrl = `${import.meta.env.BASE_URL}REKORDlogo.png`;

  const version = $derived(admin.health?.version ?? admin.diagnostics?.version ?? "");
  const localeOptions = $derived(
    ADMIN_LOCALES.map((l) => ({ value: l, label: t(`lang.${l}`) })),
  );

  function changeLocale(next: string) {
    i18n.setLocale(next);
    // Feedback already on screen was written in the old language.
    admin.message = "";
  }

  onMount(() => {
    void admin.refresh();
    return () => admin.stopPolling();
  });
</script>

<div class="shell" data-theme="server">
  <aside class="rail">
    <div class="brand">
      <img class="logo" src={logoUrl} alt="" width="40" height="40" decoding="async" />
      <BrandMark
        eyebrow={version ? t("app.eyebrowVersion", { version }) : t("app.eyebrow")}
        title="RE-KORD"
        size="sm"
      />
    </div>
    <nav class="nav" aria-label={t("app.navLabel")}>
      {#each SECTIONS as id (id)}
        <NavButton
          label={t(`nav.${id}`)}
          active={admin.section === id}
          onclick={() => void admin.show(id)}
        />
      {/each}
    </nav>
    {#if admin.access && !admin.access.canManageMachine}
      <p class="rail-note">{t("app.readOnlyNote")}</p>
    {/if}
  </aside>

  <main class="page">
    <header class="head">
      <div class="head-text">
        <h1>{t(`nav.${admin.section}`)}</h1>
        <p>{t(`lede.${admin.section}`)}</p>
      </div>
      <label class="lang">
        <span class="lang-label">{t("lang.label")}</span>
        <Select
          options={localeOptions}
          value={i18n.locale}
          onchange={(e) => changeLocale((e.currentTarget as HTMLSelectElement).value)}
        />
      </label>
    </header>

    {#if admin.keyNeeded}
      <!-- The hub wants an access key: nothing else can load without it. -->
      {#key `${admin.keyNeeded}:${admin.keyRetryAfter ?? ""}`}
        <AccessKeyPrompt
          reason={admin.keyNeeded}
          retryAfter={admin.keyRetryAfter}
          onaccepted={() => admin.keyAccepted()}
        />
      {/key}
    {:else}
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
    {:else if admin.section === "podcasts"}
      <PodcastsPanel />
    {:else if admin.section === "network"}
      <NetworkPanel />
    {/if}
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

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }

  .logo {
    flex: 0 0 auto;
    width: 2.5rem;
    height: 2.5rem;
    object-fit: contain;
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

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .head-text {
    min-width: 0;
    flex: 1 1 18rem;
  }

  .lang {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex: 0 0 auto;
  }

  .lang-label {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
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
