<script lang="ts">
  import { BrandLogo, IconRailButton } from "@rekord/ui";
  import type { ViewId } from "../lib/session.svelte";
  import { session } from "../lib/session.svelte";
  import { t } from "../lib/i18n.svelte";
  import GraphicEq from "./icons/GraphicEq.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import LevelProgressRing from "./LevelProgressRing.svelte";

  let {
    active,
    onnavigate,
  }: {
    active: ViewId;
    onnavigate: (id: ViewId) => void;
  } = $props();

  const studioAnimated = $derived(session.playing);
  const level = $derived(Math.max(1, Math.min(99, Math.floor((session.stats?.track_count ?? 0) / 80) + 1)));
  const pct = $derived(((session.stats?.track_count ?? 0) % 80) / 80 * 100);
  const levelLabel = $derived(
    t("nav.level", { level, pct: Math.round(pct) }),
  );
</script>

<aside class="rail" aria-label={t("nav.aria")}>
  <div class="logo">
    <BrandLogo size="md" />
  </div>
  <nav>
    <div class="section">
      <IconRailButton
        label={t("nav.home")}
        active={active === "dashboard"}
        onclick={() => onnavigate("dashboard")}
      >
        <UiIcon name="home" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.studio")}
        active={active === "studio"}
        onclick={() => onnavigate("studio")}
      >
        <GraphicEq animated={studioAnimated} />
      </IconRailButton>
      <IconRailButton
        label={t("nav.library")}
        active={active === "library"}
        onclick={() => onnavigate("library")}
      >
        <UiIcon name="disc" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.plectr")}
        active={active === "plectr"}
        onclick={() => onnavigate("plectr")}
      >
        <UiIcon name="plectrum" />
      </IconRailButton>
    </div>
    <hr class="sep" />
    <div class="section">
      <IconRailButton
        label={t("nav.queue")}
        active={active === "queue"}
        onclick={() => onnavigate("queue")}
      >
        <UiIcon name="list" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.playlists")}
        active={active === "playlists"}
        onclick={() => onnavigate("playlists")}
      >
        <UiIcon name="queueMusic" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.favorites")}
        active={active === "favorites"}
        onclick={() => onnavigate("favorites")}
      >
        <UiIcon name="favorite" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.recent")}
        active={active === "recent"}
        onclick={() => onnavigate("recent")}
      >
        <UiIcon name="history" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.statistics")}
        active={active === "statistics"}
        onclick={() => onnavigate("statistics")}
      >
        <UiIcon name="chart" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.achievements")}
        active={active === "achievements"}
        onclick={() => onnavigate("achievements")}
      >
        <UiIcon name="trophy" />
      </IconRailButton>
      <IconRailButton
        label={t("nav.settings")}
        active={active === "settings"}
        onclick={() => onnavigate("settings")}
      >
        <UiIcon name="settings" />
      </IconRailButton>
    </div>
  </nav>
  <div class="footer">
    <LevelProgressRing
      {level}
      {pct}
      loading={!session.stats}
      active={active === "achievements"}
      title={levelLabel}
      ariaLabel={levelLabel}
      onclick={() => onnavigate("achievements")}
    />
  </div>
</aside>

<style>
  .rail {
    grid-row: 1 / 3;
    width: var(--rk-rail-w);
    min-width: var(--rk-rail-w);
    height: 100dvh;
    position: sticky;
    top: 0;
    align-self: start;
    border-right: 1px solid var(--rk-line);
    background: var(--rk-sidebar-bg);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    /* Il rail è il bordo sinistro dello schermo: in orizzontale la tacca cade qui. */
    padding: 0 0 0 env(safe-area-inset-left, 0px);
    z-index: var(--rk-z-sidebar);
    overflow: hidden;
  }

  .logo {
    display: grid;
    place-items: center;
    padding: max(0.85rem, env(safe-area-inset-top)) 0 0.65rem;
    min-height: 56px;
  }

  nav {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--rk-space-xs) 0 var(--rk-space-md);
    display: flex;
    flex-direction: column;
    gap: var(--rk-space-lg);
    scrollbar-width: none;
  }

  nav::-webkit-scrollbar {
    display: none;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    align-items: center;
    width: 100%;
  }

  .sep {
    width: 1.75rem;
    height: 1px;
    background: var(--rk-line);
    margin: 0.15rem auto;
    border: none;
  }

  .footer {
    padding: 0.5rem 0 max(0.85rem, env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
  }

  @media (max-width: 999.98px) {
    .rail {
      display: none;
    }
  }
</style>
