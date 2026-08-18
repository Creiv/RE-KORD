<script lang="ts">
  import { CoverArt } from "@rekord/ui";
  import { onMount } from "svelte";
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
  import StudioDownloadPane from "../components/studio/StudioDownloadPane.svelte";
  import StudioMetaPane from "../components/studio/StudioMetaPane.svelte";
  import ListenVisualizer from "../components/visualizer/ListenVisualizer.svelte";
  import {
    albumCoverUrl,
    type CatalogWebItem,
    type Track,
  } from "../lib/api";
  import { formatTrackGenresForDisplay } from "../lib/genres";
  import { t } from "../lib/i18n.svelte";
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

  const tabs = $derived([
    { id: "listen", label: t("page.studio.tab.listen") },
    { id: "catalog", label: t("page.studio.tab.catalog") },
    { id: "download", label: t("page.studio.tab.download") },
    { id: "meta", label: t("page.studio.tab.meta") },
    { id: "covers", label: t("page.studio.tab.covers") },
  ]);

  let recent = $state<Track[]>([]);
  let listenRecentPanel = $state<"recent" | "lyrics">("recent");
  /** Temporary visualizer override from the KARAOKE toggle; prefs stay untouched. */
  let karaokeMode = $state(false);
  let autoPanelTrack: number | null = null;
  let panelPickedByUser = false;
  let downloadSeedUrl = $state("");
  let downloadSeedMode = $state<"single" | "playlist" | "releases">("single");

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
  const currentMoods = $derived.by(() => {
    const t = session.current;
    if (!t) return [];
    return resolveTrackMoods(t.id, t.rel_path, loadUserPrefs().trackMoods);
  });
  const currentMissingMeta = $derived.by(() => {
    const t = session.current;
    if (!t) return false;
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
    const t = session.current;
    if (!listenTrackYear || !t?.release_date) return undefined;
    return `Track ${fmtDate(t.release_date)}`;
  });
  const listenInfoLine = $derived.by(() => {
    const t = session.current;
    if (!t) return "";
    const parts: string[] = [];
    if (currentAlbum?.release_date) {
      parts.push(`Album ${fmtDate(currentAlbum.release_date)}`);
    }
    const g = formatTrackGenresForDisplay(trackGenre(t));
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

  async function loadRecent() {
    if (!session.catalogTracks.length) {
      try {
        await session.loadCatalogTracks();
      } catch {
        /* offline */
      }
    }
    const curRel = session.current?.rel_path;
    const paths = player
      .recentRelPaths()
      .filter((p) => !curRel || p !== curRel)
      .slice(0, 6);
    const byPath = new Map<string, Track>();
    for (const t of session.catalogTracks) byPath.set(t.rel_path, t);
    for (const t of session.favorites) byPath.set(t.rel_path, t);
    for (const t of session.queue) byPath.set(t.rel_path, t);
    const out: Track[] = [];
    for (const path of paths) {
      const t = byPath.get(path);
      if (t) out.push(t);
    }
    recent = out;
  }


  function sendWebItemToDownload(item: CatalogWebItem, mode: "single" | "playlist") {
    downloadSeedUrl = item.url;
    downloadSeedMode = mode;
    session.studioPane = "download";
  }

  onMount(() => {
    if (!session.artists.length) void session.loadArtists();
    if (!session.allAlbums.length) void session.loadAllAlbums();
    void loadRecent();
    return player.subscribe(() => {
      void loadRecent();
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
  title={t("page.studio.title")}
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
      <div class="studio-pane studio-pane--listen" role="region" aria-label="Ascolta">
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
                        title="Cambia cover album"
                        aria-label="Cambia cover album"
                        onclick={() => {
                          const t = session.current;
                          if (t) void session.openLibraryForTrack(t);
                        }}
                      >
                        <div class="listen-stage__art">
                          <CoverArt
                            title={session.current.title}
                            seed={`${session.current.artist_name}/${session.current.album_name}`}
                            src={session.current.album_id != null
                              ? albumCoverUrl(session.current.album_id)
                              : ""}
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
                          <p class="rk-eyebrow">Ascolto corrente</p>
                          {#if session.current}
                            <div class="listen-stage__eyebrow-actions">
                              <button
                                type="button"
                                class="listen-stage__fav"
                                class:is-on={favCurrent}
                                title="Preferito"
                                aria-pressed={favCurrent}
                                aria-label="Preferito"
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
                                title="Modifica metadati"
                                aria-label="Modifica metadati"
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
                                  ? "Includi nello shuffle"
                                  : "Escludi dallo shuffle"}
                                aria-pressed={excludedCurrent}
                                aria-label={excludedCurrent
                                  ? "Includi nello shuffle"
                                  : "Escludi dallo shuffle"}
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
                        <h1 class="listen-stage__title">
                          {session.current?.title || "Nessun brano in riproduzione"}
                        </h1>
                        {#if !session.current}
                          <p class="listen-stage__sub">
                            Apri la libreria o una playlist per iniziare.
                          </p>
                        {/if}
                      </div>
                      {#if session.current}
                        <div class="listen-stage__meta-full">
                          <p class="listen-stage__sub listen-stage__sub--with-stats">
                            <span class="listen-stage__sub-lead">
                              {session.current.artist_name} · {session.current.album_name}
                              <span class="track-row__meta-sep" aria-hidden="true"> · </span>
                              <TrackLyricsIcon
                                kind={lyricsKind(session.current?.lyrics)}
                                class="listen-stage__lyrics-inline"
                              />
                              {#if durationLabel}
                                {" "}· {durationLabel}
                              {/if}
                            </span>
                            <span class="listen-stage__sub-sep" aria-hidden="true"> · </span>
                            <span
                              class="track-row__plays listen-stage__sub-plays"
                              aria-label={`Ascolti: ${playCount}`}
                            >
                              ({playCount})
                            </span>
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

              <div class="listen-stage__viz">
                <ListenVisualizer
                  playing={session.playing}
                  mode={karaokeMode ? "karaoke" : undefined}
                  lyrics={session.current?.lyrics ?? ""}
                  currentTime={session.currentTime}
                />
              </div>

              <ListenSleepTimer />
            </section>

            <div class="listen-page__panels listen-dashboard-row">
              <section class="rk-surface-card listen-queue-panel">
                <div class="section-head section-head--page-toolbar library-genre-tracklist-headrow">
                  <SectionHeadLead eyebrow="Coda" title="Prossimi brani">
                    <UiIcon name="list" />
                  </SectionHeadLead>
                  <button
                    type="button"
                    class="text-btn"
                    onclick={() => session.navigate("queue")}
                  >
                    Gestisci
                  </button>
                </div>
                <div class="listen-queue-panel__body">
                  {#if session.queue.length === 0}
                    <div class="panel-empty panel-empty--actions">
                      <p>La coda è vuota.</p>
                      <PlayCollectionButton
                        label="Riproduci tutto"
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
                          ? "Recenti"
                          : "Brano in riproduzione"}
                      </p>
                      <SectionNavTabs
                        tabs={[
                          { id: "recent", label: "Ultimi ascolti" },
                          { id: "lyrics", label: "Testo" },
                        ]}
                        active={listenRecentPanel}
                        ariaLabel="Pannello recenti e testo"
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
                      Vedi tutto
                    </button>
                  {:else}
                    <div class="listen-recent-panel__lyrics-tools">
                      <button
                        type="button"
                        class="listen-recent-panel__karaoke-btn"
                        class:is-active={karaokeMode}
                        disabled={lyricsKind(session.current?.lyrics) !== "lrc"}
                        title={karaokeMode
                          ? "Torna al visualizzatore"
                          : "Karaoke nel visualizzatore"}
                        aria-pressed={karaokeMode}
                        onclick={() => (karaokeMode = !karaokeMode)}
                      >
                        <UiIcon name="music" />
                        <span>KARAOKE</span>
                      </button>
                      <span
                        class="listen-recent-panel__lrc-state"
                        title={lyricsKind(session.current?.lyrics) === "lrc"
                          ? "LRC disponibile"
                          : "Testo LRC non disponibile"}
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
                        La cronologia si popolerà dopo i primi ascolti.
                      </p>
                    {/if}
                  {:else if session.current?.lyrics?.trim()}
                    <SyncedLyrics
                      lyrics={session.current.lyrics}
                      currentTime={session.currentTime}
                    />
                  {:else}
                    <div class="panel-empty panel-empty--actions listen-recent-lyrics__empty">
                      <p>Nessun testo per questo brano.</p>
                      <button
                        type="button"
                        class="ghost-btn ghost-btn--sm"
                        onclick={() => session.openTrackEdit(session.current!)}
                        disabled={!session.current}
                      >
                        Modifica / Auto LRC
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
      <StudioDownloadPane seedUrl={downloadSeedUrl} seedMode={downloadSeedMode} />
    {:else if session.studioPane === "meta"}
      <StudioMetaPane />
    {:else}
      <StudioCoversPane />
    {/if}
  </div>
</section>
</div>
