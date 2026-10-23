<script lang="ts">
  import { modalSurface, sheetDrag } from "@rekord/ui";
  import type { ViewId } from "../lib/session.svelte";
  import GraphicEq from "./icons/GraphicEq.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import { session } from "../lib/session.svelte";
  import { hubModules } from "../lib/hubModules.svelte";
  import { features } from "../lib/features.svelte";
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
      // The "More" sheet (issue #100): the places you go all the time (queue,
      // playlists, settings) as wide tiles, the rest as squares in a 4-column
      // grid; same entries as before, only the shape changed.
      { id: "queue" as const, labelKey: "nav.queue", icon: "list" as const, wide: true },
      { id: "playlists" as const, labelKey: "nav.playlists", icon: "queueMusic" as const, wide: true },
      { id: "favorites" as const, labelKey: "nav.favorites", icon: "favorite" as const, wide: false },
      { id: "recent" as const, labelKey: "nav.recent", icon: "history" as const, wide: false },
      { id: "statistics" as const, labelKey: "nav.statistics", icon: "chart" as const, wide: false },
      { id: "achievements" as const, labelKey: "nav.achievements", icon: "trophy" as const, wide: false },
      ...(hubModules.podcasts
        ? [{ id: "podcasts" as const, labelKey: "nav.podcasts", icon: "podcast" as const, wide: false }]
        : []),
      ...(features.plectr
        ? [{ id: "plectr" as const, labelKey: "nav.plectr", icon: "plectrum" as const, wide: false }]
        : []),
      { id: "settings" as const, labelKey: "nav.settings", icon: "settings" as const, wide: true },
    ].map((x) => ({ ...x, label: t(x.labelKey) })),
  );

  const moreActive = $derived(moreItems.some((x) => x.id === active));

  function go(id: ViewId) {
    moreOpen = false;
    onnavigate(id);
  }
</script>

<nav class="bottom mobile-bottom-nav" aria-label={t("nav.mobileAria")}>
  <div class="inner">
    <button
      type="button"
      class:active={active === "dashboard"}
      aria-current={active === "dashboard" ? "page" : undefined}
      onclick={() => go("dashboard")}
    >
      <span class="icon"><UiIcon name="home" /></span>
      <span class="label">{t("nav.home")}</span>
    </button>
    <button
      type="button"
      class:active={active === "studio"}
      aria-current={active === "studio" ? "page" : undefined}
      onclick={() => go("studio")}
    >
      <!-- The live Studio icon, like the sidebar (legacy RekordNavIcon). -->
      <span class="icon"><GraphicEq animated={session.playing} live beat={Math.floor(session.currentTime)} /></span>
      <span class="label">{t("nav.studio")}</span>
    </button>
    <button
      type="button"
      class:active={active === "library"}
      aria-current={active === "library" ? "page" : undefined}
      onclick={() => go("library")}
    >
      <span class="icon"><UiIcon name="disc" /></span>
      <span class="label">{t("nav.library")}</span>
    </button>
    <button
      type="button"
      class:active={moreActive || moreOpen}
      aria-expanded={moreOpen}
      aria-haspopup="dialog"
      onclick={() => (moreOpen = !moreOpen)}
    >
      <span class="icon"><UiIcon name="more" /></span>
      <span class="label">{t("nav.more")}</span>
    </button>
  </div>
</nav>

{#if moreOpen}
  <div class="sheet">
    <button
      type="button"
      class="backdrop"
      tabindex="-1"
      aria-label={t("nav.close")}
      onclick={() => (moreOpen = false)}
    ></button>
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-label={t("nav.more")}
      tabindex="-1"
      use:modalSurface={{ onclose: () => (moreOpen = false), focusPanelOnly: true }}
      use:sheetDrag={{
        enabled: true,
        gripSelector: "[data-sheet-grip]",
        onclose: () => (moreOpen = false),
      }}
    >
      <div class="rk-sheet__grip" data-sheet-grip aria-hidden="true"></div>
      <header data-sheet-grip>
        <strong>{t("nav.more")}</strong>
        <button type="button" class="close" onclick={() => (moreOpen = false)} aria-label={t("nav.close")}>
          <UiIcon name="close" />
        </button>
      </header>
      <div class="grid">
        {#each moreItems as item (item.id)}
          <button
            type="button"
            class:active={active === item.id}
            class:wide={item.wide}
            class:square={!item.wide}
            aria-current={active === item.id ? "page" : undefined}
            onclick={() => go(item.id)}
          >
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

  @media (max-width: 999.98px) {
    .bottom {
      display: block;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: var(--rk-z-nav);
      border-top: 1px solid var(--rk-line);
      background: color-mix(in srgb, var(--rk-surface-2) 97%, var(--rk-bg));
      box-shadow: 0 -2px 18px color-mix(in srgb, black 28%, transparent);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .inner {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      max-width: 32rem;
      min-height: var(--rk-mobile-nav-h);
      margin-inline: auto;
      padding: 0 max(0.25rem, env(safe-area-inset-right, 0px)) 0
        max(0.25rem, env(safe-area-inset-left, 0px));
    }

    /* 5.x parity: indicator bar on top, tinted icon, bold label. */
    .inner > button {
      position: relative;
      display: grid;
      align-content: center;
      justify-items: center;
      gap: var(--rk-space-3xs);
      min-width: 0;
      min-height: var(--rk-mobile-nav-h);
      padding: var(--rk-space-sm) var(--rk-space-3xs) var(--rk-space-xs);
      border: 0;
      background: transparent;
      color: var(--rk-muted);
      font: inherit;
      font-size: var(--rk-fs-1);
      font-weight: 700;
      letter-spacing: 0.01em;
      line-height: var(--rk-lh-tight);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      transition: color 0.15s ease;
    }

    .inner > button::before {
      content: "";
      position: absolute;
      top: 0;
      left: 50%;
      width: 1.5rem;
      height: 3px;
      border-radius: 0 0 3px 3px;
      background: var(--rk-accent-2);
      transform: translateX(-50%) scaleX(0);
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .inner > button.active {
      color: var(--rk-ink);
    }

    .inner > button.active::before {
      transform: translateX(-50%) scaleX(1);
    }

    .inner > button.active .icon {
      color: var(--rk-accent-2);
    }

    .inner > button:active .icon {
      transform: scale(0.9);
    }

    .inner > button:focus-visible {
      outline: 2px solid var(--rk-focus);
      outline-offset: -3px;
      border-radius: var(--rk-radius);
    }

    .icon {
      display: grid;
      place-items: center;
      transition: transform 0.12s ease;
    }

    .icon :global(svg),
    .icon :global(.geq) {
      width: 1.45rem;
      height: 1.45rem;
    }

    .label {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
    border-radius: var(--rk-radius-2xl) var(--rk-radius-2xl) 0 0;
    background: var(--rk-surface-2);
    border-top: 1px solid var(--rk-line);
    padding: 0.15rem max(1rem, env(safe-area-inset-right, 0px))
      calc(1rem + env(safe-area-inset-bottom, 0px))
      max(1rem, env(safe-area-inset-left, 0px));
    /* The sheet does not pass scrolling on to the page below. */
    overscroll-behavior: contain;
    animation: rk-sheet-rise 0.2s ease-out;
    outline: none;
  }

  .panel header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .close {
    display: grid;
    place-items: center;
    min-width: var(--rk-tap-min);
    min-height: var(--rk-tap-min);
    border: 0;
    background: transparent;
    color: var(--rk-muted);
    padding: 0.25rem;
    cursor: pointer;
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
    font-size: var(--rk-fs-1);
    font-weight: 600;
    line-height: var(--rk-lh-tight);
    text-align: center;
    cursor: pointer;
  }

  .grid button.wide {
    grid-column: span 2;
    grid-template-columns: auto 1fr;
    align-items: center;
    justify-items: start;
    text-align: left;
    padding-inline: 0.8rem;
    gap: 0.6rem;
  }

  .grid button.square {
    aspect-ratio: 1;
    align-content: center;
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
