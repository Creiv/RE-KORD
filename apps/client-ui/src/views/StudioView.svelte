<script lang="ts">
  import { isExternalTrack } from "../lib/externalItems";
  import { CoverArt } from "@rekord/ui";
  import { onMount, untrack } from "svelte";
  import ListenSleepTimer from "../components/ListenSleepTimer.svelte";
  import MetaBadgeCluster from "../components/MetaBadgeCluster.svelte";
  import PageToolbar from "../components/PageToolbar.svelte";
  import PlayCollectionButton from "../components/PlayCollectionButton.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import SectionNavTabs from "../components/SectionNavTabs.svelte";
  import SyncedLyrics from "../components/SyncedLyrics.svelte";
  import TrackList from "../components/TrackList.svelte";
  import TrackLyricsIcon from "../components/TrackLyricsIcon.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import StudioCatalogPane from "../components/studio/StudioCatalogPane.svelte";
  import StudioCoversPane from "../components/studio/StudioCoversPane.svelte";
  import StudioDownloadConfirmDialog from "../components/studio/StudioDownloadConfirmDialog.svelte";
  import StudioDownloadPane from "../components/studio/StudioDownloadPane.svelte";
  import StudioMetaPane from "../components/studio/StudioMetaPane.svelte";
  import ListenVisualizer from "../components/visualizer/ListenVisualizer.svelte";
  import { features } from "../lib/features.svelte";
  import {
    coverUrlFor,
    type CatalogWebItem,
    type Track,
  } from "../lib/api";
  import { formatTrackGenresForDisplay } from "../lib/genres";
  import { t } from "../lib/i18n.svelte";
  import { listenMetaParts, type ListenMetaPart } from "../lib/listenMeta";
  import { formatTime, player } from "../lib/player";
  import { session, type StudioPane } from "../lib/session.svelte";
  import {
    fmtDate,
    lyricsKind,
    resolveTrackMoods,
    trackGenre,
    trackHasFileMeta,
    trackYear,
  } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";
  import { studioAccess } from "../lib/studio/access.svelte";
  import { studioDownloads } from "../lib/studio/downloadStore.svelte";
  import { downloadFlow, readSavedDownloadDest } from "../lib/studio/downloadFlow.svelte";
  import type { LibraryHit } from "../lib/studio/libraryMatch";
  import { studioErrorText } from "../lib/studio/errors";
  import { toasts } from "../lib/toasts.svelte";
  import { classicModeForUrl } from "../lib/youtubeUrl";

  const tabs = $derived([
    { id: "listen", label: t("page.studio.tab.listen") },
    { id: "catalog", label: t("page.studio.tab.catalog") },
    { id: "download", label: t("page.studio.tab.download") },
    { id: "meta", label: t("page.studio.tab.meta") },
    { id: "covers", label: t("page.studio.tab.covers") },
  ]);

  /** Per-pane heading: the toolbar says what this tab is for. */
  const paneTitle = $derived(t(`studio.header.${session.studioPane}`));

  let recent = $state<Track[]>([]);
  let listenRecentPanel = $state<"recent" | "lyrics">("recent");
  /** Temporary visualizer override from the KARAOKE toggle; prefs stay untouched. */
  let karaokeMode = $state(false);
  let autoPanelTrack: number | null = null;
  let panelPickedByUser = false;

  /** Podcast episode / live stream: no library actions on the stage. */
  const currentExternal = $derived(isExternalTrack(session.current));
  const favCurrent = $derived(
    session.current ? session.favoriteIds.has(session.current.id) : false,
  );
  const excludedCurrent = $derived(
    session.current ? player.isTrackExcluded(session.current) : false,
  );
  const playCount = $derived.by(() => {
    session.tick;
    return session.current ? player.playCount(session.current) : 0;
  });
  const durationLabel = $derived(
    session.current?.duration_ms
      ? formatTime(session.current.duration_ms / 1000)
      : null,
  );
  const listenMeta = $derived(
    session.current
      ? listenMetaParts({
          artist: session.current.artist_name,
          album: session.current.album_name,
          lyrics: lyricsKind(session.current.lyrics),
          duration: durationLabel,
          plays: currentExternal ? null : playCount,
          external: currentExternal,
        })
      : [],
  );
  const listenLeadParts = $derived(listenMeta.filter((p) => p.kind !== "plays"));
  const listenPlays = $derived(
    listenMeta.find((p): p is Extract<ListenMetaPart, { kind: "plays" }> => p.kind === "plays"),
  );
  const currentMoods = $derived.by(() => {
    const t = session.current;
    if (!t) return [];
    return resolveTrackMoods(t.id, t.rel_path, loadUserPrefs().trackMoods);
  });
  const currentMissingMeta = $derived.by(() => {
    const t = session.current;
    if (!t || isExternalTrack(t)) return false;
    return !trackHasFileMeta(t);
  });
  const currentAlbum = $derived.by(() => {
    const t = session.current;
    if (!t?.album_id) return null;
    return session.allAlbums.find((a) => a.id === t.album_id) ?? null;
  });
  const listenTrackYear = $derived(
    session.current ? trackYear(session.current, currentAlbum) : null,
  );
  const listenTrackYearTitle = $derived.by(() => {
    const cur = session.current;
    if (!listenTrackYear || !cur?.release_date) return undefined;
    return t("studio.listen.trackDate", { date: fmtDate(cur.release_date) });
  });
  const listenInfoLine = $derived.by(() => {
    const cur = session.current;
    if (!cur) return "";
    const parts: string[] = [];
    if (currentAlbum?.release_date) {
      parts.push(t("studio.listen.albumDate", { date: fmtDate(currentAlbum.release_date) }));
    }
    const g = formatTrackGenresForDisplay(trackGenre(cur));
    if (g) parts.push(g);
    if (currentAlbum?.label?.trim()) parts.push(currentAlbum.label.trim());
    return parts.join(" · ");
  });

  // Open the lyrics tab for tracks that have a text, until the user picks a tab.
  $effect(() => {
    const track = session.current;
    const id = track?.id ?? null;
    if (id !== autoPanelTrack) {
      autoPanelTrack = id;
      panelPickedByUser = false;
    }
    if (panelPickedByUser) return;
    listenRecentPanel = track?.lyrics?.trim() ? "lyrics" : "recent";
  });

  const listenQueueStart = $derived(Math.max(0, session.currentIndex - 1));
  const listenQueuePreview = $derived(
    session.queue.slice(listenQueueStart, listenQueueStart + 6),
  );

  /**
   * path → track over the catalog (tens of thousands of rows): rebuilt only
   * when one of the lists changes, not on every player event.
   */
  const trackByPath = $derived.by(() => {
    const byPath = new Map<string, Track>();
    for (const tr of session.catalogTracks) byPath.set(tr.rel_path, tr);
    for (const tr of session.favorites) byPath.set(tr.rel_path, tr);
    for (const tr of session.queue) byPath.set(tr.rel_path, tr);
    return byPath;
  });

  let catalogRequested = false;

  async function ensureCatalog() {
    if (session.catalogTracks.length || catalogRequested) return;
    catalogRequested = true;
    try {
      await session.loadCatalogTracks();
    } catch {
      /* offline */
    }
  }

  function loadRecent() {
    const curRel = session.current?.rel_path;
    const index = trackByPath;
    const out: Track[] = [];
    for (const path of player.recentRelPaths()) {
      if (curRel && path === curRel) continue;
      const tr = index.get(path);
      if (tr) out.push(tr);
      if (out.length >= 6) break;
    }
    const same =
      out.length === recent.length && out.every((tr, i) => tr === recent[i]);
    if (!same) recent = out;
  }

  // Recompute when the index changes (catalog loaded, favorites, queue).
  $effect(() => {
    trackByPath;
    untrack(loadRecent);
  });


  /**
   * Scopri › Scarica: the same confirm as the Download pane, on the folder
   * picked there. No usable folder yet → the dialog offers to pick one, which
   * opens Download with the link filled in (the old behaviour).
   */
  async function sendWebItemToDownload(
    item: CatalogWebItem,
    mode: "single" | "playlist",
    library: LibraryHit | null = null,
  ) {
    try {
      const r = await downloadFlow.run({
        url: item.url,
        scope: mode,
        title: item.title,
        subtitle: item.subtitle,
        thumbnailUrl: item.thumbnailUrl,
        releaseTitle: mode === "playlist" ? item.title : undefined,
        destPath: readSavedDownloadDest(),
        library,
      });
      if (r === "pickDest") {
        studioDownloads.url = item.url;
        studioDownloads.urlMode = classicModeForUrl(item.url, mode);
        studioDownloads.studioMode = "classic";
        session.studioPane = "download";
      } else if (r === "started") {
        // Progress and log live in the Download pane.
        session.studioPane = "download";
      }
    } catch (e) {
      toasts.error(studioErrorText(e));
    }
  }

  onMount(() => {
    if (!session.artists.length) void session.loadArtists();
    if (!session.allAlbums.length) void session.loadAllAlbums();
    studioAccess.ensure();
    void ensureCatalog();
    loadRecent();
    return player.subscribe(() => {
      loadRecent();
    });
  });

  $effect(() => {
    if (!session.current) {
      listenRecentPanel = "recent";
    }
  });
</script>

<div class="view-page studio-page">
<PageToolbar
  eyebrow={t("page.studio.eyebrow")}
  title={paneTitle}
  {tabs}
  activeTab={session.studioPane}
  tabsAriaLabel={t("page.studio.tabsAria")}
  ontab={(id) => (session.studioPane = id as StudioPane)}
>
  {#snippet icon()}
    {#if session.studioPane === "listen"}
      <UiIcon name="headphones" class="section-head__ic" />
    {:else if session.studioPane === "catalog"}
      <UiIcon name="sync" class="section-head__ic" />
    {:else if session.studioPane === "download"}
      <UiIcon name="download" class="section-head__ic" />
    {:else if session.studioPane === "meta"}
      <UiIcon name="note" class="section-head__ic" />
    {:else}
      <UiIcon name="image" class="section-head__ic" />
    {/if}
  {/snippet}
</PageToolbar>

<section
  class={session.studioPane === "listen" ? "studio-listen-shell" : "rk-surface-card studio-page-card"}
>
  <div class="tools tool-studio-layout">
    {#if session.studioPane === "listen"}
      <div class="studio-pane studio-pane--listen" role="region" aria-label={t("studio.listen.regionAria")}>
        <div class="view-page view-page--listen">
          <div class="listen-page">
            <section class="listen-page__stage listen-stage">
              <div class="listen-stage__primary">
                <div class="listen-stage__meta">
                  <div class="listen-stage__head">
                    {#if session.current}
                      <button
                        type="button"
                        class="listen-stage__art-btn"
                        title={t("studio.listen.changeCover")}
                        aria-label={t("studio.listen.changeCover")}
                        disabled={currentExternal}
                        onclick={() => {
                          const cur = session.current;
                          if (cur && !isExternalTrack(cur)) void session.openLibraryForTrack(cur);
                        }}
                      >
                        <div class="listen-stage__art">
                          <CoverArt
                            title={session.current.title}
                            seed={`${session.current.artist_name}/${session.current.album_name}`}
                            src={coverUrlFor(session.current)}
                            size="lg"
                          />
                        </div>
                        <span class="listen-stage__cover-edit-badge" aria-hidden="true">
                          <UiIcon name="image" />
                        </span>
                      </button>
                    {:else}
                      <div class="listen-stage__art listen-stage__art--empty" aria-hidden="true">
                        <UiIcon name="music" class="listen-stage__empty-ic" />
                      </div>
                    {/if}

                    <div class="listen-stage__text">
                      <div class="listen-stage__text-lead">
                        <div class="listen-stage__eyebrow-row">
                          <p class="rk-eyebrow">{t("studio.listen.currentEyebrow")}</p>
                          {#if session.current && !currentExternal}
                            <div class="listen-stage__eyebrow-actions">
                              <button
                                type="button"
                                class="listen-stage__fav"
                                class:is-on={favCurrent}
                                title={t("player.favorite")}
                                aria-pressed={favCurrent}
                                aria-label={t("player.favorite")}
                                onclick={() =>
                                  session.current &&
                                  void session.toggleFavorite(session.current)}
                              >
                                <span class="listen-stage__fav-ic" aria-hidden="true">
                                  <UiIcon name="favorite" />
                                </span>
                              </button>
                              <button
                                type="button"
                                class="track-row__ic track-row__ic--meta"
                                title={t("studio.listen.editMeta")}
                                aria-label={t("studio.listen.editMeta")}
                                onclick={() =>
                                  session.current && session.openTrackEdit(session.current)}
                              >
                                <span class="track-row__ic-glyph track-row__ic-glyph--svg">
                                  <UiIcon name="edit" />
                                </span>
                              </button>
                              <button
                                type="button"
                                class="track-row__ic track-row__ic--exclude"
                                class:is-on={excludedCurrent}
                                title={excludedCurrent
                                  ? t("studio.listen.includeShuffle")
                                  : t("studio.listen.excludeShuffle")}
                                aria-pressed={excludedCurrent}
                                aria-label={excludedCurrent
                                  ? t("studio.listen.includeShuffle")
                                  : t("studio.listen.excludeShuffle")}
                                onclick={() =>
                                  session.current &&
                                  player.toggleExcludeTrack(session.current)}
                              >
                                <span
                                  class="track-row__ic-glyph track-row__ic-glyph--svg"
                                  aria-hidden="true"
                                >
                                  <UiIcon name="exclude" />
                                </span>
                              </button>
                            </div>
                            {#if listenTrackYear}
                              <span
                                class="listen-stage__track-year"
                                title={listenTrackYearTitle}
                              >
                                {listenTrackYear}
                              </span>
                            {/if}
                          {/if}
                        </div>
                        <h1
                          class="listen-stage__title"
                          class:listen-stage__title--idle={!session.current}
                          title={session.current?.title || undefined}
                        >
                          {session.current?.title || t("studio.listen.noTrack")}
                        </h1>
                        {#if !session.current}
                          <p class="listen-stage__sub">
                            {t("studio.listen.noTrackHint")}
                          </p>
                        {/if}
                      </div>
                      {#if session.current}
                        <div class="listen-stage__meta-full">
                          <p class="listen-stage__sub listen-stage__sub--with-stats">
                            <span class="listen-stage__sub-lead">
                              {#each listenLeadParts as part, i (part.kind)}
                                {#if i > 0}<span class="track-row__meta-sep" aria-hidden="true"> · </span>{/if}
                                {#if part.kind === "names"}
                                  <span class="listen-stage__sub-names" title={part.text}>{part.text}</span>
                                {:else if part.kind === "lyrics"}
                                  <TrackLyricsIcon kind={part.lyrics} class="listen-stage__lyrics-inline" />
                                {:else if part.kind === "duration"}
                                  {part.text}
                                {/if}
                              {/each}
                            </span>
                            {#if listenPlays}
                              {#if listenLeadParts.length > 0}
                                <span class="listen-stage__sub-sep" aria-hidden="true"> · </span>
                              {/if}
                              <span
                                class="track-row__plays listen-stage__sub-plays"
                                aria-label={t("studio.listen.playsAria", { n: listenPlays.count })}
                              >
                                ({listenPlays.count})
                              </span>
                            {/if}
                            <MetaBadgeCluster
                              variant="inline"
                              moods={currentMoods}
                              missingMeta={currentMissingMeta}
                            />
                          </p>
                          {#if listenInfoLine}
                            <div class="listen-stage__detail">
                              <p class="track-row__badges listen-stage__meta-badges">
                                {listenInfoLine}
                              </p>
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>

              {#if features.visualizer || karaokeMode}
                <div class="listen-stage__viz">
                  <ListenVisualizer
                    playing={session.playing}
                    mode={karaokeMode ? "karaoke" : undefined}
                    lyrics={session.current?.lyrics ?? ""}
                    currentTime={session.currentTime}
                  />
                </div>
              {/if}

              <ListenSleepTimer />
            </section>

            <div class="listen-page__panels listen-dashboard-row">
              <section class="rk-surface-card listen-queue-panel">
                <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
                  <SectionHeadLead eyebrow={t("studio.listen.queueEyebrow")} title={t("studio.listen.queueHeading")}>
                    <UiIcon name="list" />
                  </SectionHeadLead>
                  <button
                    type="button"
                    class="text-btn"
                    onclick={() => session.navigate("queue")}
                  >
                    {t("studio.listen.manageQueue")}
                  </button>
                </div>
                <div class="listen-queue-panel__body">
                  {#if session.queue.length === 0}
                    <div class="panel-empty panel-empty--actions">
                      <p>{t("studio.listen.queueEmpty")}</p>
                      <PlayCollectionButton
                        label={t("studio.listen.playAll")}
                        onclick={() => void session.shuffleLibrary()}
                      />
                    </div>
                  {:else}
                    <div class="list-stack listen-queue-panel__list">
                      <TrackList
                        tracks={listenQueuePreview}
                        favoriteIds={session.favoriteIds}
                        playlistOptions={session.playlistOptions}
                        activeTrackId={session.current?.id ?? null}
                        onplay={(track) => {
                          const idx = session.queue.findIndex((t) => t.id === track.id);
                          if (idx >= 0) session.playQueueIndex(idx);
                        }}
                        ontoggleFavorite={(track) => void session.toggleFavorite(track)}
                        onaddToPlaylist={(playlistId, track) =>
                          void session.addToPlaylist(playlistId, track.id)}
                      />
                    </div>
                  {/if}
                </div>
              </section>

              <section class="rk-surface-card listen-recent-panel">
                <div class="section-head section-head--page-toolbar listen-recent-panel__head">
                  <div class="section-head__lead listen-recent-panel__lead">
                    <span class="section-head__icon-wrap" aria-hidden="true">
                      {#if listenRecentPanel === "recent"}
                        <UiIcon name="history" />
                      {:else}
                        <UiIcon name="note" />
                      {/if}
                    </span>
                    <div class="section-head__text">
                      <p class="rk-eyebrow">
                        {listenRecentPanel === "recent"
                          ? t("studio.listen.recentEyebrow")
                          : t("studio.listen.lyricsEyebrow")}
                      </p>
                      <SectionNavTabs
                        tabs={[
                          { id: "recent", label: t("studio.listen.tabRecent") },
                          { id: "lyrics", label: t("studio.listen.tabLyrics") },
                        ]}
                        active={listenRecentPanel}
                        ariaLabel={t("studio.listen.panelTabsAria")}
                        onselect={(id) => {
                          if (id === "lyrics" && !session.current) return;
                          panelPickedByUser = true;
                          listenRecentPanel = id as "recent" | "lyrics";
                        }}
                      />
                    </div>
                  </div>
                  {#if listenRecentPanel === "recent"}
                    <button
                      type="button"
                      class="text-btn"
                      onclick={() => session.navigate("recent")}
                    >
                      {t("studio.listen.seeAll")}
                    </button>
                  {:else}
                    <div class="listen-recent-panel__lyrics-tools">
                      <button
                        type="button"
                        class="listen-recent-panel__karaoke-btn"
                        class:is-active={karaokeMode}
                        disabled={lyricsKind(session.current?.lyrics) !== "lrc"}
                        title={karaokeMode
                          ? t("studio.listen.karaokeBack")
                          : t("studio.listen.karaokeOn")}
                        aria-pressed={karaokeMode}
                        onclick={() => (karaokeMode = !karaokeMode)}
                      >
                        <UiIcon name="music" />
                        <span>{t("studio.listen.karaoke")}</span>
                      </button>
                      <span
                        class="listen-recent-panel__lrc-state"
                        title={lyricsKind(session.current?.lyrics) === "lrc"
                          ? t("studio.listen.lrcAvailable")
                          : t("studio.listen.lrcMissing")}
                      >
                        <span
                          class="listen-recent-panel__lrc-dot"
                          class:is-missing={lyricsKind(session.current?.lyrics) !== "lrc"}
                          aria-hidden="true"
                        ></span>
                        LRC
                      </span>
                    </div>
                  {/if}
                </div>
                <div class="listen-recent-panel__body">
                  {#if listenRecentPanel === "recent"}
                    {#if recent.length}
                      <div class="list-stack listen-recent-panel__list">
                        <TrackList
                          tracks={recent}
                          favoriteIds={session.favoriteIds}
                          playlistOptions={session.playlistOptions}
                          activeTrackId={session.current?.id ?? null}
                          onplay={(track) => void session.playGlobalRadio(track)}
                          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
                          onaddToPlaylist={(playlistId, track) =>
                            void session.addToPlaylist(playlistId, track.id)}
                        />
                      </div>
                    {:else}
                      <p class="panel-empty">
                        {t("studio.listen.recentEmpty")}
                      </p>
                    {/if}
                  {:else if session.current?.lyrics?.trim()}
                    <SyncedLyrics
                      lyrics={session.current.lyrics}
                      currentTime={session.currentTime}
                    />
                  {:else}
                    <div class="panel-empty panel-empty--actions listen-recent-lyrics__empty">
                      <p>{t("studio.listen.noLyrics")}</p>
                      <button
                        type="button"
                        class="ghost-btn ghost-btn--sm"
                        onclick={() => session.openTrackEdit(session.current!)}
                        disabled={!session.current}
                      >
                        {t("studio.listen.editLyrics")}
                      </button>
                    </div>
                  {/if}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    {:else if session.studioPane === "catalog"}
      <StudioCatalogPane onSendToDownload={sendWebItemToDownload} />
    {:else if session.studioPane === "download"}
      <StudioDownloadPane />
    {:else if session.studioPane === "meta"}
      <StudioMetaPane />
    {:else}
      <StudioCoversPane />
    {/if}
  </div>
</section>
<StudioDownloadConfirmDialog />
</div>
