<script lang="ts">
  import type { ViewId } from "../lib/session.svelte";
  import GraphicEq from "./icons/GraphicEq.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import { session } from "../lib/session.svelte";
  import { t } from "../lib/i18n.svelte";

  let {
    active,
    onnavigate,
  }: {
    active: ViewId;
    onnavigate: (id: ViewId) => void;
  } = $props();

  let moreOpen = $state(false);

  const moreItems = $derived(
    [
      { id: "queue" as const, labelKey: "nav.queue", icon: "list" as const },
      { id: "playlists" as const, labelKey: "nav.playlists", icon: "queueMusic" as const },
      { id: "favorites" as const, labelKey: "nav.favorites", icon: "favorite" as const },
      { id: "recent" as const, labelKey: "nav.recent", icon: "history" as const },
      { id: "statistics" as const, labelKey: "nav.statistics", icon: "chart" as const },
      { id: "achievements" as const, labelKey: "nav.achievements", icon: "trophy" as const },
      { id: "plectr" as const, labelKey: "nav.plectr", icon: "plectrum" as const },
      { id: "settings" as const, labelKey: "nav.settings", icon: "settings" as const },
    ].map((x) => ({ ...x, label: t(x.labelKey) })),
  );

  const moreActive = $derived(moreItems.some((x) => x.id === active));

  function go(id: ViewId) {
    moreOpen = false;
    onnavigate(id);
  }
</script>

<nav class="bottom" aria-label={t("nav.mobileAria")}>
  <div class="inner">
    <button type="button" class:active={active === "dashboard"} onclick={() => go("dashboard")}>
      <span class="icon"><UiIcon name="home" /></span>
      <span>{t("nav.home")}</span>
    </button>
    <button type="button" class:active={active === "studio"} onclick={() => go("studio")}>
      <span class="icon"><GraphicEq animated={session.playing} /></span>
      <span>{t("nav.studio")}</span>
    </button>
    <button type="button" class:active={active === "library"} onclick={() => go("library")}>
      <span class="icon"><UiIcon name="disc" /></span>
      <span>{t("nav.library")}</span>
    </button>
    <button type="button" class:active={moreActive} onclick={() => (moreOpen = !moreOpen)}>
      <span class="icon"><UiIcon name="more" /></span>
      <span>{t("nav.more")}</span>
    </button>
  </div>
</nav>

{#if moreOpen}
  <div class="sheet" role="dialog" aria-label={t("nav.more")}>
    <button type="button" class="backdrop" aria-label={t("nav.close")} onclick={() => (moreOpen = false)}
    ></button>
    <div class="panel">
      <header>
        <strong>{t("nav.more")}</strong>
        <button type="button" class="close" onclick={() => (moreOpen = false)} aria-label={t("nav.close")}>
          <UiIcon name="close" />
        </button>
      </header>
      <div class="grid">
        {#each moreItems as item}
          <button type="button" class:active={active === item.id} onclick={() => go(item.id)}>
            <UiIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .bottom {
    display: none;
  }

  @media (max-width: 1000px) {
    .bottom {
      display: block;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: var(--rk-z-nav);
      border-top: 1px solid var(--rk-line);
      background: var(--rk-sidebar-bg);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .inner {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      min-height: 3.25rem;
      padding: 0.35rem 0.15rem;
    }

    .inner > button {
      position: relative;
      border: 0;
      background: transparent;
      color: var(--rk-muted);
      font: inherit;
      font-size: 0.58rem;
      display: grid;
      gap: 0.12rem;
      justify-items: center;
      padding: 0.35rem 0.05rem;
      cursor: pointer;
    }

    .inner > button.active {
      color: var(--rk-ink);
    }

    .inner > button.active::after {
      content: "";
      position: absolute;
      bottom: 0.15rem;
      width: 0.35rem;
      height: 0.35rem;
      border-radius: 50%;
      background: var(--rk-accent-2);
    }

    .icon :global(svg) {
      width: 1.15rem;
      height: 1.15rem;
    }
  }

  .sheet {
    position: fixed;
    inset: 0;
    z-index: calc(var(--rk-z-nav) + 5);
  }

  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: rgba(0, 0, 0, 0.45);
  }

  .panel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    border-radius: 16px 16px 0 0;
    background: var(--rk-surface-2);
    border-top: 1px solid var(--rk-line);
    padding: 0.85rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
  }

  .panel header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .close {
    border: 0;
    background: transparent;
    color: var(--rk-muted);
    padding: 0.25rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.45rem;
  }

  .grid button {
    border: 1px solid var(--rk-line);
    background: var(--rk-surface);
    border-radius: var(--rk-radius);
    color: var(--rk-ink);
    padding: 0.7rem 0.35rem;
    display: grid;
    gap: 0.35rem;
    justify-items: center;
    font: inherit;
    font-size: 0.68rem;
    cursor: pointer;
  }

  .grid button.active {
    border-color: color-mix(in srgb, var(--rk-accent) 40%, var(--rk-line));
    background: var(--rk-accent-soft);
  }

  .grid button :global(svg) {
    width: 1.2rem;
    height: 1.2rem;
    color: var(--rk-accent-2);
  }
</style>
