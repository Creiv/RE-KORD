<script lang="ts">
  import { Banner } from "@rekord/ui";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import AchievementsView from "../views/AchievementsView.svelte";
  import DashboardView from "../views/DashboardView.svelte";
  import FavoritesView from "../views/FavoritesView.svelte";
  import LibraryView from "../views/LibraryView.svelte";
  import PlectrView from "../views/PlectrView.svelte";
  import PlaylistsView from "../views/PlaylistsView.svelte";
  import QueueView from "../views/QueueView.svelte";
  import RecentView from "../views/RecentView.svelte";
  import SettingsView from "../views/SettingsView.svelte";
  import StatisticsView from "../views/StatisticsView.svelte";
  import StudioView from "../views/StudioView.svelte";
  import EditDialogs from "./EditDialogs.svelte";
  import IconRail from "./IconRail.svelte";
  import MobileBottomNav from "./MobileBottomNav.svelte";
  import PlayerDock from "./PlayerDock.svelte";
  import TopBar from "./TopBar.svelte";
</script>

<div class="shell" class:has-dock={session.hasQueue}>
  <IconRail active={session.view} onnavigate={(id) => session.navigate(id)} />

  <div class="main-col">
    <TopBar status={session.status} />

    <main class="content rk-scroll">
      <div class="inner">
        {#if session.error}
          <Banner tone="error">{session.error}</Banner>
        {/if}

        {#if session.view === "dashboard"}
          <DashboardView />
        {:else if session.view === "studio"}
          <StudioView />
        {:else if session.view === "library"}
          <LibraryView />
        {:else if session.view === "plectr"}
          <PlectrView />
        {:else if session.view === "favorites"}
          <FavoritesView />
        {:else if session.view === "playlists"}
          <PlaylistsView />
        {:else if session.view === "queue"}
          <QueueView />
        {:else if session.view === "recent"}
          <RecentView />
        {:else if session.view === "statistics"}
          <StatisticsView />
        {:else if session.view === "achievements"}
          <AchievementsView />
        {:else}
          <SettingsView />
        {/if}
      </div>
    </main>
  </div>

  {#if session.hasQueue}
    <PlayerDock
      current={session.current}
      playing={session.playing}
      currentTime={session.currentTime}
      duration={session.duration}
      shuffle={session.shuffle}
      repeat={session.repeat}
      favorited={session.isFavoriteCurrent}
      excluded={session.isCurrentExcluded}
      excludeLocked={session.isCurrentAlbumExcluded}
      ontoggle={() => void player.toggle()}
      onprev={() => void player.prev()}
      onnext={() => void player.next()}
      onseek={(s) => player.seek(s)}
      ontoggleShuffle={() => player.toggleShuffle()}
      oncycleRepeat={() => player.cycleRepeat()}
      ontoggleFavorite={() => void session.toggleFavoriteCurrent()}
      ontoggleExclude={() => session.toggleExcludeCurrent()}
      onradio={() => void session.radioFromCurrent()}
      onopenAlbum={() => {
        const t = session.current;
        if (t) void session.openLibraryForTrack(t);
      }}
      onopenArtist={() => {
        const t = session.current;
        if (t) void session.openLibraryArtist(t);
      }}
      onopenStudio={() => {
        session.studioPane = "listen";
        session.navigate("studio");
      }}
    />
  {/if}

  <MobileBottomNav active={session.view} onnavigate={(id) => session.navigate(id)} />
  <EditDialogs />
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--rk-side-w) 1fr;
    grid-template-rows: 1fr auto;
    height: 100dvh;
    max-height: 100dvh;
    overflow: hidden;
  }

  .main-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .content {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--rk-space-5) 1.25rem 1.25rem;
    scrollbar-gutter: stable;
  }

  /* Clear fixed PlayerDock — parity with 5.x --content-pad-bottom when dock visible */
  .shell.has-dock .content {
    padding-bottom: calc(
      env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + 1.25rem
    );
    scroll-padding-bottom: calc(
      env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + 1.25rem
    );
  }

  .inner {
    max-width: var(--rk-content-max);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--rk-section-gap);
    min-width: 0;
  }

  /* Ritmo verticale solo da --rk-section-gap: niente margin extra tra blocchi. */
  .inner > :global(.rk-surface-card),
  .inner > :global(.rk-panel),
  .inner > :global(.rk-hero),
  .inner > :global(.rk-section-header),
  .inner > :global(.rk-banner),
  .inner > :global(.library-filter-panel),
  .inner > :global(.view-page) {
    margin-bottom: 0;
  }

  @media (max-width: 1000px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr auto;
    }

    .shell.has-dock .content {
      padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-mobile-nav-h) +
          1.05rem
      );
      scroll-padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-mobile-nav-h) +
          1.05rem
      );
    }

    .content {
      padding-inline: 1rem;
    }
  }
</style>
