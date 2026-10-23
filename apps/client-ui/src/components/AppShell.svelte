<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { Banner, Button, Skeleton, isModalOpen, setUiLabels } from "@rekord/ui";
  import { connectGate } from "../lib/connect.svelte";
  import { t } from "../lib/i18n.svelte";
  import { bindNavHistory } from "../lib/navHistory.svelte";
  import { hubModules } from "../lib/hubModules.svelte";
  import { isExternalTrack } from "../lib/externalItems";
  import { reloadWithFreshShell } from "../lib/platform/pwa";
  import { player } from "../lib/player";
  import { session, type ViewId } from "../lib/session.svelte";

  /** Seconds the hub has been unreachable; ticks once a second only while it is. */
  let offlineFor = $state(0);
  /** The connect flow was opened by this outage already: once is enough. */
  let autoConnectDone = false;
  const OFFLINE_AUTO_CONNECT_S = 120;
  $effect(() => {
    const since = session.hubDownSince;
    if (since == null) {
      offlineFor = 0;
      autoConnectDone = false;
      return;
    }
    const tick = () => {
      offlineFor = Math.max(0, Math.round((Date.now() - since) / 1000));
      if (!autoConnectDone && offlineFor >= OFFLINE_AUTO_CONNECT_S && connectGate.phase === "app") {
        autoConnectDone = true;
        connectGate.open();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  });
  function formatOfflineFor(s: number): string {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return s % 60 ? `${m}min ${s % 60}s` : `${m}min`;
  }
  import {
    SHORTCUT_SEEK_SECONDS,
    SHORTCUTS_OFF_ATTR,
    shortcutActionFor,
  } from "../lib/shortcutList";
  import { toasts } from "../lib/toasts.svelte";
  import { trackViewportMetrics } from "../lib/viewportMetrics";
  // The landing view stays in the entry chunk; every other view is its own
  // chunk, fetched on first visit (and warmed up once the app is idle).
  import DashboardView from "../views/DashboardView.svelte";
  import ConfirmHost from "./ConfirmHost.svelte";
  import EditDialogs from "./EditDialogs.svelte";
  import IconRail from "./IconRail.svelte";
  import MobileBottomNav from "./MobileBottomNav.svelte";
  import PlayerDock from "./PlayerDock.svelte";
  import ToastStack from "./ToastStack.svelte";
  import TopBar from "./TopBar.svelte";
  import ViewBoundary from "./ViewBoundary.svelte";

  type LazyView = Exclude<ViewId, "dashboard">;
  type ViewModule = { default: Component };

  const VIEW_LOADERS: Record<LazyView, () => Promise<ViewModule>> = {
    studio: () => import("../views/StudioView.svelte"),
    library: () => import("../views/LibraryView.svelte"),
    plectr: () => import("../views/PlectrView.svelte"),
    favorites: () => import("../views/FavoritesView.svelte"),
    playlists: () => import("../views/PlaylistsView.svelte"),
    queue: () => import("../views/QueueView.svelte"),
    recent: () => import("../views/RecentView.svelte"),
    statistics: () => import("../views/StatisticsView.svelte"),
    achievements: () => import("../views/AchievementsView.svelte"),
    settings: () => import("../views/SettingsView.svelte"),
    // Optional module: fetched only when the hub has it on and it is opened.
    podcasts: () => import("../views/PodcastsView.svelte"),
  };

  /** Views of optional modules: never warmed up in the background. */
  const MODULE_VIEWS: ReadonlySet<LazyView> = new Set<LazyView>(["podcasts"]);

  /** Loaded view components (plain object in $state: lookups stay reactive). */
  let loadedViews = $state<Partial<Record<LazyView, Component>>>({});
  let viewLoadErrors = $state<Partial<Record<LazyView, unknown>>>({});
  const inFlight = new Map<LazyView, Promise<void>>();

  function loadView(id: LazyView): Promise<void> {
    if (loadedViews[id]) return Promise.resolve();
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = VIEW_LOADERS[id]()
      .then((mod) => {
        loadedViews[id] = mod.default;
        delete viewLoadErrors[id];
      })
      .catch((err: unknown) => {
        viewLoadErrors[id] = err;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  /** Chunks that failed again after a Retry: the next Retry reloads the page. */
  const retryFailed = new Set<LazyView>();

  function retryView(id: LazyView) {
    // Browsers keep a failed `import()` in their module map, so the same URL
    // may keep failing without a new request (and after a hub update the old
    // chunk is gone for good): once a plain retry failed, reload.
    if (retryFailed.has(id) && viewLoadErrors[id]) {
      void reloadWithFreshShell();
      return;
    }
    delete viewLoadErrors[id];
    void loadView(id).then(() => {
      if (viewLoadErrors[id]) retryFailed.add(id);
    });
  }

  const lazyId = $derived(
    session.view === "dashboard" ? null : (session.view as LazyView),
  );
  const LazyComponent = $derived(lazyId ? (loadedViews[lazyId] ?? null) : null);

  $effect(() => {
    if (lazyId) void loadView(lazyId);
  });

  /** Warm the other chunks once the first screen is up, one at a time. */
  onMount(() => {
    let cancelled = false;
    const idle = (cb: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(cb, { timeout: 4000 });
      } else {
        setTimeout(cb, 1500);
      }
    };
    const timer = window.setTimeout(() => {
      const queue = (Object.keys(VIEW_LOADERS) as LazyView[]).filter((id) => !MODULE_VIEWS.has(id));
      const next = () => {
        if (cancelled) return;
        const id = queue.shift();
        if (!id) return;
        void loadView(id).then(() => idle(next));
      };
      idle(next);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  });

  function goHome() {
    session.navigate("dashboard");
  }

  // An episode restored from the last session keeps its resume point and
  // listened mark: load the (small) tracker only then.
  $effect(() => {
    if (!hubModules.podcasts || !isExternalTrack(session.current)) return;
    void import("../lib/podcasts/store.svelte").then((m) => m.podcasts.bindTracker());
  });

  // The hub switched the module off (or never had it): leave its view.
  $effect(() => {
    if (session.view === "podcasts" && hubModules.list != null && !hubModules.podcasts) {
      session.navigate("dashboard");
    }
  });

  onMount(trackViewportMetrics);

  // Shared components have no i18n: hand them the labels they show.
  $effect(() => {
    setUiLabels({
      close: t("ui.close"),
      empty: t("common.empty"),
      search: t("common.search"),
      searchPlaceholder: t("common.searchPlaceholder"),
      back: t("common.back"),
    });
  });

  // Section changes leave history entries: Android Back walks them (and closes
  // open dialogs first) instead of quitting the app.
  bindNavHistory();

  function focusSearch() {
    session.navigate("library");
    window.dispatchEvent(new CustomEvent("rekord:focus-search"));
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutActionFor(e, {
        modalOpen: isModalOpen(),
        suspended: !!document.querySelector(`[${SHORTCUTS_OFF_ATTR}]`),
      });
      if (!action) return;
      switch (action) {
        case "search":
          e.preventDefault();
          focusSearch();
          return;
        case "play":
          e.preventDefault();
          void player.toggle();
          return;
        case "seekBack":
        case "seekForward": {
          if (!player.current) return;
          e.preventDefault();
          const at = player.currentTime;
          const dur = player.duration;
          const delta = action === "seekBack" ? -SHORTCUT_SEEK_SECONDS : SHORTCUT_SEEK_SECONDS;
          const max = dur > 0 ? Math.max(0, dur - 0.5) : Number.POSITIVE_INFINITY;
          player.seek(Math.min(max, Math.max(0, at + delta)));
          return;
        }
        case "listen":
          e.preventDefault();
          session.studioPane = "listen";
          session.navigate("studio");
          return;
        case "shuffle":
          e.preventDefault();
          player.toggleShuffle();
          // The shortcut has no button under the cursor: say what changed.
          toasts.flash(
            t(player.shuffle ? "core.shortcut.shuffleOn" : "core.shortcut.shuffleOff"),
            "shortcut",
          );
          return;
        case "plectr":
          e.preventDefault();
          session.navigate("plectr");
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="shell" class:has-dock={session.hasQueue}>
  <IconRail active={session.view} onnavigate={(id) => session.activateNav(id)} />

  <div class="main-col">
    <TopBar status={session.status} />

    <main class="content rk-scroll">
      <div class="inner">
        {#if session.error}
          {#if session.status === "offline" && session.hubDownSince != null}
            <!-- Hub unreachable: how long for, retry at once, or change hub (issue #100).
                 After a couple of minutes the connect flow opens by itself: on the phone the
                 hub changes address as soon as the router renumbers it. -->
            <Banner tone="error">
              {offlineFor < 5
                ? session.error
                : t("core.hub.unreachableFor", { time: formatOfflineFor(offlineFor) })}
            </Banner>
            <div class="offline-out">
              <Button variant="secondary" onclick={() => session.retryHubNow()}>
                {t("core.hub.retryNow")}
              </Button>
              <Button variant="ghost" onclick={() => connectGate.open()}>
                {t("settings.changeHub")}
              </Button>
            </div>
          {:else}
            <Banner tone="error">{session.error}</Banner>
            {#if session.status === "offline"}
              <div class="offline-out">
                <Button variant="ghost" onclick={() => connectGate.open()}>
                  {t("settings.changeHub")}
                </Button>
              </div>
            {/if}
          {/if}
        {/if}

        {#if session.view === "dashboard"}
          {#key session.dashboardHomeTick}
            <ViewBoundary name="dashboard">
              <DashboardView />
            </ViewBoundary>
          {/key}
        {:else if lazyId}
          {#key `${lazyId}:${lazyId === "studio" ? session.studioHomeTick : lazyId === "settings" ? session.settingsHomeTick : 0}`}
            <ViewBoundary
              name={lazyId}
              loadError={viewLoadErrors[lazyId] ?? null}
              onretry={() => retryView(lazyId)}
              onhome={goHome}
            >
              {#if LazyComponent}
                <LazyComponent />
              {:else}
                <!-- Chunk still loading: the page's shape, not a blank area. -->
                <div class="view-skeleton" role="status" aria-label={t("ui.loading")}>
                  <div class="view-skeleton__head rk-surface-card">
                    <Skeleton variant="text" lines={2} width="14rem" />
                  </div>
                  <Skeleton variant="row" count={4} />
                </div>
              {/if}
            </ViewBoundary>
          {/key}
        {/if}
      </div>
    </main>
  </div>

  {#if session.hasQueue}
    <ViewBoundary name="player" compact>
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
          if (t && isExternalTrack(t)) session.navigate(hubModules.podcasts ? "podcasts" : "dashboard");
          else if (t) void session.openLibraryForTrack(t);
        }}
        onopenArtist={() => {
          const t = session.current;
          if (t && isExternalTrack(t)) session.navigate(hubModules.podcasts ? "podcasts" : "dashboard");
          else if (t) void session.openLibraryArtist(t);
        }}
        onopenStudio={() => {
          session.studioPane = "listen";
          session.navigate("studio");
        }}
      />
    </ViewBoundary>
  {/if}

  <MobileBottomNav active={session.view} onnavigate={(id) => session.activateNav(id)} />
  <ViewBoundary name="edit-dialogs" compact>
    <EditDialogs />
  </ViewBoundary>
  <ConfirmHost />
  <ToastStack />
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--rk-rail-w) 1fr;
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
    padding: var(--rk-page-pad-y) var(--rk-page-pad-r) var(--rk-page-pad-x)
      var(--rk-page-pad-l);
    scrollbar-gutter: stable;
    /* The end-of-list bounce stays here: it must not reach the fixed shell. */
    overscroll-behavior: contain;
  }

  /* Clear fixed PlayerDock — parity with 5.x --content-pad-bottom when dock visible */
  .shell.has-dock .content {
    padding-bottom: calc(
      env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-page-pad-x)
    );
    scroll-padding-bottom: calc(
      env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-page-pad-x)
    );
  }

  .view-skeleton {
    display: grid;
    gap: var(--rk-section-gap);
  }

  .view-skeleton__head {
    padding-block: var(--rk-space-lg);
  }

  .offline-out {
    display: flex;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: var(--rk-space-sm);
  }

  .inner {
    max-width: var(--rk-content-max);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--rk-section-gap);
    min-width: 0;
  }

  /* Desktop: the width chosen in Settings › Interface for this device. */
  @media (min-width: 1000px) {
    .inner {
      max-width: var(--rk-user-content-max, var(--rk-content-max));
    }
  }

  /* Vertical rhythm only from --rk-section-gap: no extra margin between blocks. */
  .inner > :global(.rk-surface-card),
  .inner > :global(.rk-panel),
  .inner > :global(.rk-hero),
  .inner > :global(.rk-section-header),
  .inner > :global(.rk-banner),
  .inner > :global(.library-filter-panel),
  .inner > :global(.view-page) {
    margin-bottom: 0;
  }

  @media (max-width: 999.98px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr auto;
    }

    /* The bottom nav is fixed: without a dock the end of the page must still
       clear it (and the home indicator). */
    .content {
      padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-mobile-nav-h) + var(--rk-page-pad-x)
      );
      scroll-padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-mobile-nav-h) + var(--rk-page-pad-x)
      );
    }

    .shell.has-dock .content {
      padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-mobile-nav-h) +
          var(--rk-page-pad-x)
      );
      scroll-padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--rk-dock-h) + var(--rk-mobile-nav-h) +
          var(--rk-page-pad-x)
      );
    }
  }
</style>
