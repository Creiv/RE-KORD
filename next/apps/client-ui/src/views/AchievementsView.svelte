<script lang="ts">
  import { onMount } from "svelte";
  import { Panel } from "@rekord/ui";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import {
    buildAchievementsSnapshot,
    type AchievementIconKind,
  } from "../lib/achievements";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";
  import { trackGenre } from "../lib/trackMoods";

  let bootstrapped = $state(false);

  function iconName(
    kind: AchievementIconKind,
  ):
    | "play"
    | "favorite"
    | "queueMusic"
    | "disc"
    | "chart"
    | "shuffle"
    | "music"
    | "history"
    | "plectrum" {
    switch (kind) {
      case "heart":
        return "favorite";
      case "list":
        return "queueMusic";
      case "artist":
        return "disc";
      case "genre":
        return "chart";
      case "shuffle":
        return "shuffle";
      case "library":
        return "music";
      case "streak":
      case "flame":
        return "history";
      case "plectr":
        return "plectrum";
      default:
        return "play";
    }
  }

  const snapshot = $derived.by(() => {
    session.tick;
    session.favorites;
    session.playlists;
    session.catalogTracks;
    session.stats;
    if (!bootstrapped) return null;
    const playlists = session.playlists;
    const playlistTrackCount = playlists.reduce(
      (s, p) => s + (p.track_count ?? 0),
      0,
    );
    return buildAchievementsSnapshot({
      playCounts: player.allPlayCounts(),
      tracks: session.catalogTracks,
      favoritesCount: session.favorites.length,
      playlistsCount: playlists.length,
      playlistTrackCount,
      libraryTrackCount:
        session.stats?.track_count ?? session.catalogTracks.length,
      shuffleBlocks:
        player.getExcludedRelPaths().size + player.getExcludedAlbumIds().size,
      genreForTrack: (t) => trackGenre(t),
      plectrTracksPlayed: 0,
    });
  });

  const loading = $derived(!bootstrapped || snapshot == null);
  const unlocked = $derived(
    snapshot?.achievements.filter((a) => a.unlocked).length ?? 0,
  );

  onMount(() => {
    void (async () => {
      try {
        await Promise.all([
          session.ensureCatalogTracks(),
          session.favorites.length ? Promise.resolve() : session.loadFavorites(),
          session.playlists.length ? Promise.resolve() : session.loadPlaylists(),
          session.stats ? Promise.resolve() : session.loadStats(),
        ]);
      } finally {
        bootstrapped = true;
      }
    })();
    return player.subscribe(() => {
      session.tick += 1;
    });
  });
</script>

<div class="view-page achievements-page">
  <header class="achievements-page__hero view-page__intro">
    <section class="achievements-hero rk-surface-card">
      <h1 class="achievements-hero__rank">
        {#if loading || !snapshot}
          …
        {:else}
          <span class="achievements-hero__level">Livello {snapshot.level.level} -</span
          >{' '}{snapshot.level.title}
        {/if}
      </h1>

      <div
        class="achievements-hero__xp"
        aria-label="Avanzamento esperienza"
        aria-busy={loading}
      >
        <div
          class="achievements-xp__track"
          role="progressbar"
          aria-valuenow={loading || !snapshot ? undefined : snapshot.progress.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={loading || !snapshot
            ? "Caricamento progresso achievement"
            : `Progresso livello ${snapshot.progress.pct}%`}
        >
          {#if loading || !snapshot}
            <div class="achievements-xp__fill achievements-xp__fill--shimmer"></div>
          {:else}
            <div
              class="achievements-xp__fill"
              style="width: {snapshot.progress.pct}%"
            ></div>
          {/if}
        </div>
        <p class="achievements-hero__xp-caption">
          {#if loading || !snapshot}
            Caricamento statistiche e achievement…
          {:else}
            <strong>{snapshot.totalXp}</strong>
            {" XP · "}
            {Math.max(0, snapshot.level.xpMax + 1 - snapshot.totalXp)} al grado
            successivo
          {/if}
        </p>
      </div>

      <ul class="achievements-hero__stats" aria-label="Traguardi di ascolto">
        <li>
          <strong>{loading || !snapshot ? "—" : snapshot.signals.totalPlays}</strong>
          <span>Riproduzioni totali</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot ? "—" : snapshot.signals.artistsWithPlays}
          </strong>
          <span>Artisti esplorati</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot ? "—" : snapshot.signals.favoritesCount}
          </strong>
          <span>Preferiti</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot
              ? "—"
              : `${unlocked}/${snapshot.achievements.length}`}
          </strong>
          <span>Badge</span>
        </li>
        <li
          class="achievements-hero__stat-streak"
          title="Serie giornaliera di ascolto"
        >
          <strong>{loading || !snapshot ? "—" : snapshot.streak}</strong>
          <span>giorni di fila</span>
        </li>
      </ul>

      <div class="achievements-hero__actions">
        <button
          type="button"
          class="primary-btn"
          onclick={() => {
            session.studioPane = "listen";
            session.navigate("studio");
          }}
        >
          Continua ad ascoltare
        </button>
        <button
          type="button"
          class="ghost-btn"
          onclick={() => session.navigate("statistics")}
        >
          Vedi statistiche
        </button>
      </div>
    </section>
  </header>

  <div class="achievements-page__main view-page__main" aria-busy={loading}>
    <Panel title="Tutti i badge" class="achievements-board">
      {#snippet actions()}
        <p class="achievements-board__lead">
          {#if loading || !snapshot}
            …
          {:else}
            {unlocked}/{snapshot.achievements.length}
          {/if}
        </p>
      {/snippet}
      <ul class="achievements-badge-grid">
        {#each snapshot?.achievements ?? [] as ach (ach.id)}
          <li
            class="achievements-badge"
            class:achievements-badge--unlocked={ach.unlocked}
            class:achievements-badge--locked={!ach.unlocked}
            aria-label={ach.unlocked
              ? `Sbloccato: ${ach.title}`
              : `Da sbloccare: ${ach.title}`}
          >
            <span class="achievements-badge__icon" aria-hidden="true">
              <UiIcon
                name={iconName(ach.icon)}
                class="achievements-badge__ic"
              />
            </span>
            <div class="achievements-badge__body">
              <h3>{ach.title}</h3>
              <p>{ach.desc}</p>
              <span class="achievements-badge__xp">+{ach.xpBonus} XP</span>
            </div>
            <span
              class="achievements-badge__state"
              class:achievements-badge__state--unlocked={ach.unlocked}
              class:achievements-badge__state--locked={!ach.unlocked}
              aria-hidden="true"
            >
              {ach.unlocked ? "✓" : "○"}
            </span>
          </li>
        {/each}
      </ul>
    </Panel>
  </div>
</div>
