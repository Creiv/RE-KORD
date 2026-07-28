<script lang="ts">
  import { BrandLogo, IconButton } from "@rekord/ui";
  import { onMount } from "svelte";
  import { session } from "../lib/session.svelte";
  import UiIcon from "./icons/UiIcon.svelte";

  let {
    status = "",
  }: {
    status?: string;
  } = $props();

  let syncSpin = $state(false);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function openSearch() {
    session.focusSearch();
    queueMicrotask(() => {
      document.querySelector<HTMLInputElement>(".search-hero input")?.focus();
    });
  }

  async function sync() {
    syncSpin = true;
    try {
      await session.refreshAll();
    } finally {
      setTimeout(() => (syncSpin = false), 600);
    }
  }

</script>

<header class="top">
  <div class="row">
    <div class="start">
      <div class="brand-mobile">
        <BrandLogo size="sm" />
      </div>
      <div class="title-block">
        <p class="breadcrumb">RE-KORD</p>
        <h1 class="page-title">{session.pageTitle}</h1>
      </div>
    </div>
    <div class="end">
      {#if status}
        <span class="status" title="Stato hub">
          {status === "indexing" ? "indexing…" : status}
        </span>
      {/if}
      <span class="ver">5.1.0</span>
      <IconButton surface label="Sincronizza" onclick={() => void sync()}>
        <span class:spin={syncSpin}><UiIcon name="sync" /></span>
      </IconButton>
      <IconButton surface label="Cerca (Ctrl+K)" onclick={openSearch}>
        <UiIcon name="search" />
      </IconButton>
    </div>
  </div>
</header>

<style>
  .top {
    position: sticky;
    top: 0;
    z-index: var(--rk-z-sticky);
    border-bottom: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-topbar-bg) 88%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    flex-shrink: 0;
    /* Stesso canale orizzontale di .content → .inner (padding fuori dal max-width + gutter). */
    padding-inline: 1.25rem;
    scrollbar-gutter: stable;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--rk-space-4);
    min-height: var(--rk-header-h);
    max-width: var(--rk-content-max);
    margin: 0 auto;
    padding: max(0.5rem, env(safe-area-inset-top)) 0 0.5rem;
  }

  .start {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .brand-mobile {
    display: none;
  }

  .title-block {
    min-width: 0;
    display: grid;
    gap: 0.08rem;
  }

  .breadcrumb {
    margin: 0;
    font-size: 0.68rem;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--rk-accent-2) 65%, var(--rk-muted) 35%);
    line-height: 1.2;
  }

  .page-title {
    margin: 0;
    font-size: 1.22rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--rk-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }

  .end {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.4rem;
  }

  .status,
  .ver {
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rk-muted);
    font-weight: 650;
    white-space: nowrap;
  }

  .ver {
    color: var(--rk-accent-2);
    margin-right: 0.1rem;
  }

  .spin {
    display: inline-grid;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 1000px) {
    .top {
      padding-inline: 1rem;
    }

    .brand-mobile {
      display: grid;
    }
  }
</style>
