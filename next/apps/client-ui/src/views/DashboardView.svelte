<script lang="ts">
  import { onMount } from "svelte";
  import {
    Button,
    HeroCard,
    MetricCard,
    Panel,
  } from "@rekord/ui";
  import MediaGrid from "../components/MediaGrid.svelte";
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import TrackMoodGlyph from "../components/TrackMoodGlyph.svelte";
  import GraphicEq from "../components/icons/GraphicEq.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { albumCoverUrl, api, type Track } from "../lib/api";
  import { matchesDown } from "../lib/breakpoints";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import { t } from "../lib/i18n.svelte";
  import {
    TRACK_MOOD_COLORS,
    TRACK_MOOD_IDS,
    TRACK_MOOD_LABELS,
    albumGenre,
    albumHasAlbumMeta,
    resolveTrackMoods,
    trackGenre,
    trackHasFileMeta,
    trackMatchesMoodFilter,
    trackYear,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs } from "../lib/userPrefs";

  type RadioTile = {
    id: number;
    title: string;
    moods: TrackMoodId[];
    cover: string;
    track: Track;
  };

  const SMART_RADIO_MIN_COLS = 4;
  const SMART_RADIO_MAX_COLS = 14;
  const SMART_RADIO_MIN_TILE_REM = 5.5;

  let mixGenres = $state<string[]>([]);
  let mixMoods = $state<TrackMoodId[]>([]);
  let mixMatchAll = $state(false);
  let radioGridEl = $state<HTMLDivElement | null>(null);
  let radioColumns = $state(6);
  /** Snapshot stabile per visita (come old useState lazy). */
  let radioSessionPicks = $state<RadioTile[]>([]);
  /** Cover fallite → placeholder (evita icona broken-image del browser). */
  let radioCoverFailed = $state<Set<number>>(new Set());
  /** URL recuperati da retry anti-flaky (come old CoverImg). */
  let radioCoverRecovered = $state<Map<number, string>>(new Map());
  const radioCoverRetrying = new Set<number>();

  function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function albumHasCover(albumId: number | null): boolean | null {
    if (albumId == null) return false;
    const album = session.allAlbums.find((a) => a.id === albumId);
    if (!album) return null;
    return album.has_cover;
  }

  function trackCoverUrl(t: Track): string {
    if (t.album_id == null) return "";
    // Se l’indice album c’è e dice no-cover, non richiedere (evita 404).
    if (albumHasCover(t.album_id) === false) return "";
    return albumCoverUrl(t.album_id, 256);
  }

  function radioTileCoverSrc(tile: RadioTile): string {
    return radioCoverRecovered.get(tile.id) ?? tile.cover;
  }

  function onRadioCoverError(tile: RadioTile) {
    const base = tile.cover;
    // Fallback immediato: niente icona broken mentre il retry gira in background.
    radioCoverFailed = new Set(radioCoverFailed).add(tile.id);
    if (!base || radioCoverRetrying.has(tile.id) || radioCoverRecovered.has(tile.id)) {
      return;
    }
    radioCoverRetrying.add(tile.id);
    const url = `${base}${base.includes("?") ? "&" : "?"}retry=1`;
    const probe = new Image();
    probe.onload = () => {
      radioCoverRetrying.delete(tile.id);
      radioCoverRecovered = new Map(radioCoverRecovered).set(tile.id, url);
      const next = new Set(radioCoverFailed);
      next.delete(tile.id);
      radioCoverFailed = next;
    };
    probe.onerror = () => {
      radioCoverRetrying.delete(tile.id);
    };
    probe.src = url;
  }

  function trackToRadioTile(
    t: Track,
    prefs: ReturnType<typeof loadUserPrefs>["trackMoods"],
  ): RadioTile {
    return {
      id: t.id,
      title: t.title,
      moods: resolveTrackMoods(t.id, t.rel_path, prefs),
      cover: trackCoverUrl(t),
      track: t,
    };
  }

  function pickRadioSessionTiles(maxTracks: number): RadioTile[] {
    session.tick;
    session.moodPrefsTick;
    const prefs = loadUserPrefs().trackMoods;
    const recentPaths = player.recentRelPaths().slice(0, 2);
    const recent: Track[] = [];
    for (const path of recentPaths) {
      const t =
        session.catalogTracks.find((x) => x.rel_path === path) ||
        session.favorites.find((x) => x.rel_path === path) ||
        session.queue.find((x) => x.rel_path === path);
      if (t) recent.push(t);
    }
    const pool = [...recent, ...session.favorites, ...session.catalogTracks];
    const seenPath = new Set<number>();
    const seenAlbum = new Set<number | string>();
    const uniqueAlbum: Track[] = [];
    const rest: Track[] = [];
    for (const t of pool) {
      if (seenPath.has(t.id) || player.isTrackExcluded(t)) continue;
      seenPath.add(t.id);
      const key = t.album_id ?? `t:${t.id}`;
      if (!seenAlbum.has(key)) {
        seenAlbum.add(key);
        uniqueAlbum.push(t);
      } else {
        rest.push(t);
      }
    }
    const picked: Track[] = [];
    for (const t of shuffleInPlace([...uniqueAlbum])) {
      if (picked.length >= maxTracks) break;
      picked.push(t);
    }
    if (picked.length < maxTracks) {
      for (const t of shuffleInPlace([...rest])) {
        if (picked.length >= maxTracks) break;
        picked.push(t);
      }
    }
    return picked.map((t) => trackToRadioTile(t, prefs));
  }

  function refreshRadioSessionPicks() {
    radioCoverFailed = new Set();
    radioCoverRecovered = new Map();
    radioCoverRetrying.clear();
    radioSessionPicks = pickRadioSessionTiles(SMART_RADIO_MAX_COLS);
  }

  onMount(() => {
    void Promise.all([
      session.ensureCatalogTracks(),
      session.allAlbums.length ? Promise.resolve() : session.loadAllAlbums(),
    ]).then(() => {
      refreshRadioSessionPicks();
    });
  });

  $effect(() => {
    const nTracks = session.catalogTracks.length;
    const nFav = session.favorites.length;
    if (radioSessionPicks.length > 0) return;
    if (nTracks === 0 && nFav === 0) return;
    refreshRadioSessionPicks();
  });

  /** Quando arriva l’indice album, togli URL cover per album senza cover. */
  $effect(() => {
    const albums = session.allAlbums;
    if (!albums.length || radioSessionPicks.length === 0) return;
    let changed = false;
    const next = radioSessionPicks.map((tile) => {
      const cover = trackCoverUrl(tile.track);
      if (cover === tile.cover) return tile;
      changed = true;
      return { ...tile, cover };
    });
    if (changed) radioSessionPicks = next;
  });

  $effect(() => {
    const el = radioGridEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const compute = () => {
      const width = el.clientWidth;
      if (width <= 8) return;
      const rootFontPx = parseFloat(
        getComputedStyle(document.documentElement).fontSize || "16",
      );
      const font = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : 16;
      const gapRaw = parseFloat(getComputedStyle(el).columnGap || "");
      const gap = Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw : 0.65 * font;
      const minTrackPx = Math.min(SMART_RADIO_MIN_TILE_REM * font, width);
      const rawCols = Math.max(1, Math.floor((width + gap) / (minTrackPx + gap)));
      const isNarrow = matchesDown("lg");
      radioColumns = isNarrow
        ? Math.max(3, Math.min(5, rawCols))
        : Math.max(SMART_RADIO_MIN_COLS, Math.min(SMART_RADIO_MAX_COLS, rawCols));
    };
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    const id = requestAnimationFrame(compute);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  });

  const radioDisplay = $derived(
    radioSessionPicks.slice(0, Math.max(0, radioColumns - 1)),
  );

  const recentAlbums = $derived(
    [...session.allAlbums]
      .sort((a, b) => b.id - a.id || a.name.localeCompare(b.name))
      .slice(0, 12),
  );

  const topFavorites = $derived(
    [...session.favorites]
      .sort(
        (a, b) =>
          player.playCount(b) - player.playCount(a) ||
          a.title.localeCompare(b.title),
      )
      .slice(0, 5),
  );

  const mixReady = $derived(mixGenres.length > 0 || mixMoods.length > 0);

  const mixPreviewCount = $derived.by(() => {
    session.tick;
    session.moodPrefsTick;
    if (!mixReady) return 0;
    const prefs = loadUserPrefs().trackMoods;
    let list = session.catalogTracks.filter((t) => !player.isTrackExcluded(t));
    if (mixGenres.length) {
      const set = new Set(mixGenres);
      list = list.filter((t) => {
        const g = trackGenre(t);
        return g != null && set.has(g);
      });
    }
    if (mixMoods.length) {
      list = list.filter((t) =>
        trackMatchesMoodFilter(
          resolveTrackMoods(t.id, t.rel_path, prefs),
          mixMoods,
          mixMatchAll,
        ),
      );
    }
    return list.length;
  });

  function clearMix() {
    mixGenres = [];
    mixMoods = [];
  }

  const mixMoodCounts = $derived.by(() => {
    session.moodPrefsTick;
    session.catalogTracks;
    const prefs = loadUserPrefs().trackMoods;
    const counts = Object.fromEntries(TRACK_MOOD_IDS.map((id) => [id, 0])) as Record<
      TrackMoodId,
      number
    >;
    for (const t of session.catalogTracks) {
      if (player.isTrackExcluded(t)) continue;
      for (const m of resolveTrackMoods(t.id, t.rel_path, prefs)) {
        counts[m] += 1;
      }
    }
    return counts;
  });

  const qualityAlerts = $derived.by(() => {
    session.catalogTracks;
    const albumsNoCover = session.albumsWithoutCover;
    // Legacy: !hasAlbumMeta && !loose
    const albumsNoMeta = session.allAlbums.filter(
      (a) => !a.loose && !albumHasAlbumMeta(a),
    ).length;
    // Legacy trackHasFileMeta: genre OR releaseDate
    const tracksNoMeta = session.catalogTracks.filter((tr) => !trackHasFileMeta(tr)).length;
    const loose = session.allAlbums.filter((a) => a.loose).length;
    return [
      {
        id: "albums-without-cover",
        label: t("dashboard.alert.albums-without-cover"),
        value: albumsNoCover,
        icon: "image" as const,
        tone: albumsNoCover > 0 ? ("warn" as const) : ("ok" as const),
      },
      {
        id: "albums-without-meta",
        label: t("dashboard.alert.albums-without-meta"),
        value: albumsNoMeta,
        icon: "album" as const,
        tone: albumsNoMeta > 0 ? ("warn" as const) : ("ok" as const),
      },
      {
        id: "tracks-without-meta",
        label: t("dashboard.alert.tracks-without-meta"),
        value: tracksNoMeta,
        icon: "note" as const,
        tone: tracksNoMeta > 0 ? ("warn" as const) : ("ok" as const),
      },
      {
        id: "loose-albums",
        label: t("dashboard.alert.loose-albums"),
        value: loose,
        icon: "list" as const,
        tone: loose > 0 ? ("info" as const) : ("ok" as const),
      },
    ];
  });

  const qualitySum = $derived(qualityAlerts.reduce((s, a) => s + a.value, 0));

  function toggleMixGenre(name: string) {
    mixGenres = mixGenres.includes(name)
      ? mixGenres.filter((g) => g !== name)
      : [...mixGenres, name];
  }

  function toggleMixMood(id: TrackMoodId) {
    mixMoods = mixMoods.includes(id)
      ? mixMoods.filter((m) => m !== id)
      : [...mixMoods, id];
  }

  async function playMix() {
    if (!mixReady) return;
    const pool = await session.ensureCatalogTracks();
    const prefs = loadUserPrefs().trackMoods;
    let list = pool.filter((t) => !player.isTrackExcluded(t));
    if (mixGenres.length) {
      const set = new Set(mixGenres);
      list = list.filter((t) => {
        const g = trackGenre(t);
        return g != null && set.has(g);
      });
    }
    if (mixMoods.length) {
      list = list.filter((t) =>
        trackMatchesMoodFilter(
          resolveTrackMoods(t.id, t.rel_path, prefs),
          mixMoods,
          mixMatchAll,
        ),
      );
    }
    if (!list.length) {
      toasts.info("Nessun brano per questa selezione mix.");
      return;
    }
    session.playPoolShuffle(list);
    session.studioPane = "listen";
    session.navigate("studio");
  }

  const genreChips = $derived.by(() => {
    session.catalogTracks;
    const map = new Map<string, number>();
    const source = session.catalogTracks.length
      ? session.catalogTracks
      : session.allAlbums.map((a) => ({
          rel_path: `${a.artist_name}/${a.name}`,
          track_count: a.track_count,
        }));
    if (session.catalogTracks.length) {
      for (const t of session.catalogTracks) {
        if (player.isTrackExcluded(t)) continue;
        const g = trackGenre(t) ?? "Senza genere";
        map.set(g, (map.get(g) ?? 0) + 1);
      }
    } else {
      for (const a of session.allAlbums) {
        const g = albumGenre(a) ?? "Senza genere";
        map.set(g, (map.get(g) ?? 0) + a.track_count);
      }
    }
    void source;
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (a.name === "Senza genere") return 1;
        if (b.name === "Senza genere") return -1;
        return b.count - a.count || a.name.localeCompare(b.name);
      })
      .slice(0, 14);
  });

  async function openAlbum(id: number | string) {
    try {
      const album = await api.album(Number(id));
      if (album.artist_id != null) {
        const artist = await api.artist(album.artist_id);
        await session.openArtist(artist);
      }
      await session.openAlbum(album);
    } catch (e) {
      toasts.fail(e);
    }
  }

  const heroListenPaused = $derived(Boolean(session.current) && !session.playing);
  const heroStartsShuffle = $derived(!session.current);

  function heroListen() {
    if (!session.current) {
      void session.shuffleLibrary().then(() => {
        session.studioPane = "listen";
        session.navigate("studio");
      });
      return;
    }
    if (!session.playing) void player.toggle();
    session.studioPane = "listen";
    session.navigate("studio");
  }

  function heroLibraryShuffle() {
    void session.shuffleLibrary().then(() => {
      session.studioPane = "listen";
      session.navigate("studio");
    });
  }

  function playRadioFrom(track: Track) {
    const library = session.catalogTracks.length
      ? session.catalogTracks
      : session.favorites.length
        ? session.favorites
        : [track];
    // Start playback first; defer Studio mount (visualizer) off the press path.
    void session.playGlobalRadio(track, library);
    window.setTimeout(() => {
      session.studioPane = "listen";
      session.navigate("studio");
    }, 0);
  }
</script>

<div class="view-page dashboard-page">
  <HeroCard title={t("page.dashboard.title")} eyebrow="RE-KORD">
    <Button class="dashboard-hero-listen-btn" onclick={heroListen}>
      {#if heroStartsShuffle}
        <UiIcon name="shuffle" class="dashboard-hero-listen-btn__ic" />
      {:else}
        <UiIcon name="play" class="dashboard-hero-listen-btn__ic" />
      {/if}
      {heroListenPaused ? "Riprendi ascolto" : "Ascolta"}
    </Button>
    {#if session.current}
      <Button
        variant="ghost"
        class="dashboard-hero-shuffle-btn"
        title="Riproduci libreria"
        aria-label="Riproduci libreria"
        onclick={heroLibraryShuffle}
      >
        <UiIcon name="shuffle" class="dashboard-hero-shuffle-btn__ic" />
      </Button>
    {/if}
  </HeroCard>

  <div class="metrics">
    <MetricCard label="Artisti" value={session.stats?.artist_count ?? "—"} />
    <MetricCard label="Album" value={session.stats?.album_count ?? "—"} />
    <MetricCard label="Brani" value={session.stats?.track_count ?? "—"} />
    <MetricCard label={t("dashboard.metricQuality")} value={qualitySum} />
  </div>

  <div class="dashboard-page__main">
    <Panel class="session-card dashboard-session-card dashboard-smart-radio-card dashboard-page__full dashboard-page__mix">
      <header class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Smart Radio" title="Ascolto veloce">
          <UiIcon name="radio" />
        </SectionHeadLead>
      </header>
      {#if radioDisplay.length === 0 && radioSessionPicks.length === 0 && session.catalogTracks.length === 0}
        <p class="muted">Aggiungi brani in libreria per popolare le tile.</p>
      {:else}
        <div
          class="dashboard-smart-radio-grid"
          bind:this={radioGridEl}
          style="--smart-radio-cols: {radioColumns}"
        >
          {#each radioDisplay as tile (tile.id)}
            {@const isCurrent = session.current?.id === tile.id}
            <div
              class="dashboard-smart-radio-tile"
              class:dashboard-smart-radio-tile--active={isCurrent}
            >
              <div class="dashboard-smart-radio-tile__media">
                {#if tile.cover && !radioCoverFailed.has(tile.id)}
                  <img
                    class="dashboard-smart-radio-tile__art"
                    src={radioTileCoverSrc(tile)}
                    alt=""
                    decoding="async"
                    onerror={() => onRadioCoverError(tile)}
                  />
                {:else}
                  <span
                    class="dashboard-smart-radio-tile__art dashboard-smart-radio-tile__art--fallback"
                    aria-hidden="true"
                  >
                    <UiIcon name="music" class="dashboard-smart-radio-tile__art-ic" />
                  </span>
                {/if}
                {#if isCurrent}
                  <button
                    type="button"
                    class="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__studio"
                    title="Apri Studio"
                    aria-label="Apri Studio"
                    onclick={() => {
                      session.studioPane = "listen";
                      session.navigate("studio");
                    }}
                  >
                    <GraphicEq animated={session.playing} />
                  </button>
                {:else}
                  <button
                    type="button"
                    class="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__play"
                    title={`Avvia radio da ${tile.title}`}
                    aria-label={`Avvia radio da ${tile.title}`}
                    onclick={() => playRadioFrom(tile.track)}
                  >
                    <UiIcon name="play" />
                  </button>
                {/if}
              </div>
              <button
                type="button"
                class="dashboard-smart-radio-tile__meta"
                title={`Avvia radio da ${tile.title}`}
                onclick={() => playRadioFrom(tile.track)}
              >
                <span class="dashboard-smart-radio-tile__title">{tile.title}</span>
                <span class="track-meta-moods-cluster dashboard-smart-radio-tile__moods">
                  {#if tile.moods.length === 0}
                    <span class="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-off" title="Nessun mood">
                      <TrackMoodGlyph mood={null} class="track-meta-mood-chip__glyph" />
                    </span>
                  {:else}
                    {#each tile.moods as m (m)}
                      <span
                        class="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-tag"
                        style="--mood-c: {TRACK_MOOD_COLORS[m]}"
                        title={TRACK_MOOD_LABELS[m]}
                      >
                        <TrackMoodGlyph mood={m} class="track-meta-mood-chip__glyph" />
                      </span>
                    {/each}
                  {/if}
                </span>
              </button>
            </div>
          {/each}
          <button
            type="button"
            class="dashboard-smart-radio-tile dashboard-smart-radio-tile--random"
            title="Casuale"
            aria-label="Casuale"
            onclick={() => {
              void session.shuffleLibrary().then(() => {
                session.studioPane = "listen";
                session.navigate("studio");
              });
            }}
          >
            <span
              class="dashboard-smart-radio-tile__media dashboard-smart-radio-tile__media--random"
              aria-hidden="true"
            >
              <UiIcon name="shuffle" />
            </span>
            <span class="dashboard-smart-radio-tile__meta">
              <span class="dashboard-smart-radio-tile__title">Casuale</span>
            </span>
          </button>
        </div>
      {/if}
    </Panel>

    <Panel class="session-card dashboard-session-card dashboard-mix-card dashboard-page__full dashboard-page__mix">
      <header class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Playlist al volo" title="Generi e mood">
          <UiIcon name="music" />
        </SectionHeadLead>
        <div class="section-head__tools">
          {#if mixReady}
            <button type="button" class="text-btn" onclick={clearMix}>Azzera</button>
          {/if}
          <button
            type="button"
            class="text-btn"
            onclick={() => {
              session.navigate("library");
              session.libraryBrowse = "genres";
            }}
          >
            Apri libreria
          </button>
        </div>
      </header>
      <div class="dashboard-mix-body">
        {#if mixReady}
          <div class="dashboard-mix-selection" aria-live="polite">
            <div class="dashboard-mix-selection__chips">
              {#each mixGenres as g (g)}
                <button
                  type="button"
                  class="dashboard-mix-pill"
                  title={`Rimuovi ${g}`}
                  aria-label={`Rimuovi ${g}`}
                  onclick={() => toggleMixGenre(g)}
                >
                  <span>{g}</span>
                  <UiIcon name="close" class="dashboard-mix-pill__x" />
                </button>
              {/each}
              {#each mixMoods as id (id)}
                <button
                  type="button"
                  class="dashboard-mix-pill dashboard-mix-pill--mood dashboard-mix-pill--mood-ico"
                  style="--mood-c:{TRACK_MOOD_COLORS[id]}"
                  title={`Rimuovi ${TRACK_MOOD_LABELS[id]}`}
                  aria-label={`Rimuovi ${TRACK_MOOD_LABELS[id]}`}
                  onclick={() => toggleMixMood(id)}
                >
                  <TrackMoodGlyph mood={id} />
                  <UiIcon name="close" class="dashboard-mix-pill__x" />
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="dashboard-mix-panels">
          <div class="dashboard-mix-panel">
            <div class="dashboard-mix-panel__head">
              <span class="dashboard-mix-panel__eyebrow">Generi</span>
              {#if mixGenres.length}
                <button type="button" class="text-btn" onclick={() => (mixGenres = [])}>
                  Pulisci
                </button>
              {/if}
            </div>
            <div class="dashboard-mix-genre-chips">
              {#each genreChips as g}
                <button
                  type="button"
                  class="dashboard-mix-genre-chip"
                  class:is-on={mixGenres.includes(g.name)}
                  aria-pressed={mixGenres.includes(g.name)}
                  title={g.name}
                  onclick={() => toggleMixGenre(g.name)}
                >
                  <span class="dashboard-mix-genre-chip__label">{g.name}</span>
                  <span class="dashboard-mix-genre-chip__count">{g.count}</span>
                </button>
              {:else}
                <p class="dashboard-mix-empty">Nessun genere in libreria</p>
              {/each}
            </div>
          </div>

          <div class="dashboard-mix-panel">
            <div class="dashboard-mix-mood-toolbar">
              <span class="dashboard-mix-panel__eyebrow">Mood</span>
              <div
                class="dashboard-mix-match segmented--joined"
                role="group"
                aria-label="Come combinare mood"
              >
                <button
                  type="button"
                  class:is-on={!mixMatchAll}
                  title="Il brano deve avere almeno uno dei mood scelti"
                  onclick={() => (mixMatchAll = false)}
                >
                  Almeno uno
                </button>
                <button
                  type="button"
                  class:is-on={mixMatchAll}
                  title="Il brano deve avere tutti i mood scelti"
                  onclick={() => (mixMatchAll = true)}
                >
                  Tutti
                </button>
              </div>
            </div>
            <div class="dashboard-mix-mood-grid">
              {#each TRACK_MOOD_IDS as id}
                {@const count = mixMoodCounts[id]}
                {@const on = mixMoods.includes(id)}
                {@const disabled =
                  session.catalogTracks.length > 0 && count === 0 && !on}
                <button
                  type="button"
                  class="library-mood-filter-btn"
                  class:library-mood-filter-btn--on={on}
                  style="--mood-c:{TRACK_MOOD_COLORS[id]}"
                  disabled={disabled}
                  title={TRACK_MOOD_LABELS[id]}
                  aria-pressed={on}
                  aria-label={TRACK_MOOD_LABELS[id]}
                  onclick={() => {
                    if (disabled) return;
                    void session.ensureCatalogTracks();
                    toggleMixMood(id);
                  }}
                >
                  <span class="library-mood-filter-btn__glyph-row">
                    <TrackMoodGlyph mood={id} inheritColor />
                    <span class="library-mood-filter-btn__count">{count}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        </div>

        <div class="dashboard-mix-footer">
          <p class="dashboard-mix-footer__hint">
            {#if !mixReady}
              Scegli genere e/o mood, poi avvia lo shuffle.
            {:else if mixPreviewCount === 0}
              Nessun brano — allarga la selezione.
            {:else}
              <strong>{mixPreviewCount}</strong>
              {mixPreviewCount === 1 ? "brano" : "brani"} in coda
            {/if}
          </p>
          <Button
            class="dashboard-mix-footer__listen"
            disabled={!mixReady || mixPreviewCount === 0}
            title={mixReady
              ? "Avvia shuffle dalla selezione"
              : "Seleziona almeno un genere o mood"}
            onclick={() => void playMix()}
          >
            <UiIcon name="shuffle" />
            Ascolta
          </Button>
        </div>
      </div>
    </Panel>

    <Panel class="session-card dashboard-session-card dashboard-page__full dashboard-page__tile">
      <header class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Album aggiornati" title="Ultimi movimenti in collezione">
          <UiIcon name="sync" />
        </SectionHeadLead>
        <div class="section-head__tools">
          <button type="button" class="text-btn" onclick={() => session.navigate("library")}>
            Apri libreria
          </button>
        </div>
      </header>
      <MediaGrid
        kind="album"
        dashboard
        items={recentAlbums.map((a) => {
          session.tick;
          const tracks = session.catalogTracks.filter((t) => t.album_id === a.id);
          const albumEx = player.isAlbumExcluded(a.id);
          const excludedPaths = player.getExcludedRelPaths();
          const trackEx = tracks.filter((t) => excludedPaths.has(t.rel_path)).length;
          const year = trackYear(null, a);
          return {
            id: a.id,
            title: a.name,
            /* Come AlbumListTile dashboard React: niente riga artista */
            metaLine: `${a.track_count} brani${year ? ` · ${year}` : ""}`,
            coverSrc: a.has_cover ? albumCoverUrl(a.id, 256) : "",
            coverSeed: `${a.artist_name}/${a.name}`,
            favoriteCount: session.favorites.filter((t) => t.album_id === a.id).length,
            tracksMissingMetaCount: tracks.filter((tr) => !trackHasFileMeta(tr)).length,
            genreMissing: !albumHasAlbumMeta(a),
            albumExcluded: albumEx,
            tracksExcludedCount: albumEx ? a.track_count : trackEx,
            loose: a.loose,
          };
        })}
        emptyMessage="Nessun album — esegui uno scan"
        onselect={(id) => void openAlbum(id)}
      />
    </Panel>

    <Panel class="session-card dashboard-session-card dashboard-page__tile">
      <header class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Preferiti" title="Scelte rapide">
          <UiIcon name="favorite" />
        </SectionHeadLead>
        <div class="section-head__tools">
          <button type="button" class="text-btn" onclick={() => session.navigate("favorites")}>
            Tutti
          </button>
        </div>
      </header>
      <div class="tight">
        <TrackList
          tracks={topFavorites}
          favoriteIds={session.favoriteIds}
          playlistOptions={session.playlistOptions}
          activeTrackId={session.current?.id ?? null}
          emptyMessage="Nessun preferito ancora"
          onplay={(track) => void session.playGlobalRadio(track)}
          ontoggleFavorite={(track) => void session.toggleFavorite(track)}
          onaddToPlaylist={(playlistId, track) =>
            void session.addToPlaylist(playlistId, track.id)}
        />
      </div>
    </Panel>

    <Panel class="session-card dashboard-session-card dashboard-page__tile dashboard-page__tile--quality">
      <header class="section-head section-head--page-toolbar">
        <SectionHeadLead eyebrow="Qualità libreria" title="Alert e manutenzione">
          <UiIcon name="build" />
        </SectionHeadLead>
        <div class="section-head__tools">
          <button type="button" class="text-btn" onclick={() => session.navigate("studio")}>
            Vai allo studio
          </button>
        </div>
      </header>
      <div class="quality">
        {#each qualityAlerts as alert}
          <div class="qcard" class:warn={alert.tone === "warn"} class:ok={alert.tone === "ok"}>
            <span class="qic"><UiIcon name={alert.icon} /></span>
            <span class="qlab">{alert.label}</span>
            <strong>{alert.value}</strong>
          </div>
        {/each}
      </div>
    </Panel>
  </div>
</div>

<style>
  :global(.dashboard-hero-listen-btn) {
    --dashboard-hero-btn-h: 2.75rem;
    min-height: var(--dashboard-hero-btn-h);
    padding: 0 1.4rem;
    font-size: var(--rk-fs-base);
    box-sizing: border-box;
  }

  :global(.dashboard-hero-listen-btn__ic) {
    width: 1.2rem;
    height: 1.2rem;
    flex-shrink: 0;
  }

  :global(.dashboard-hero-shuffle-btn) {
    width: var(--dashboard-hero-btn-h, 2.75rem);
    height: var(--dashboard-hero-btn-h, 2.75rem);
    min-width: var(--dashboard-hero-btn-h, 2.75rem);
    min-height: var(--dashboard-hero-btn-h, 2.75rem);
    padding: 0;
    flex: 0 0 auto;
  }

  :global(.dashboard-hero-shuffle-btn__ic) {
    width: 1.2rem;
    height: 1.2rem;
    flex-shrink: 0;
  }

  /* Annulla margin dei componenti UI: il ritmo verticale è solo il gap della pagina. */
  .dashboard-page > :global(.rk-hero),
  .dashboard-page__main > :global(.rk-panel) {
    margin-bottom: 0;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.55rem;
    margin: 0;
  }

  .dashboard-page__main {
    display: grid;
    gap: var(--rk-section-gap);
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    align-items: start;
  }

  .dashboard-page__main > :global(*) {
    min-width: 0;
  }

  .dashboard-page__main > :global(.dashboard-page__full) {
    grid-column: 1 / -1;
  }

  @media (min-width: 720px) {
    .dashboard-page__main {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .muted {
    margin: var(--rk-space-3xs) 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
  }

  .tight {
    padding: 0;
    margin: 0;
  }

  .quality {
    display: grid;
    gap: 0.55rem;
  }

  .qcard {
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    background: var(--rk-surface-2);
    padding: 0.75rem 0.9rem;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.7rem;
    align-items: center;
    box-shadow: var(--rk-shadow);
  }

  .qcard.warn {
    border-color: color-mix(in srgb, #f59e0b 45%, var(--rk-line));
  }

  .qcard.ok {
    border-color: color-mix(in srgb, var(--rk-accent-2) 35%, var(--rk-line));
  }

  .qic {
    display: grid;
    place-items: center;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: var(--rk-radius-xl);
    background: var(--rk-surface);
    color: var(--rk-accent);
  }

  .qlab {
    color: var(--rk-muted);
    font-size: var(--rk-fs-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 650;
    min-width: 0;
  }

  .qcard strong {
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  @media (max-width: 999.98px) {
    .metrics {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 559.98px) {
    .metrics {
      grid-template-columns: 1fr;
    }
  }
</style>
