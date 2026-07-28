<script lang="ts">
  import SectionHeadLead from "../components/SectionHeadLead.svelte";
  import TrackList from "../components/TrackList.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { session } from "../lib/session.svelte";

  const activePlaylist = $derived(
    session.playlists.find((p) => p.id === session.activePlaylistId) ?? null,
  );

  let renameDraft = $state("");

  $effect(() => {
    renameDraft = activePlaylist?.name ?? "";
  });

  async function playPlaylist(id: string) {
    await session.openPlaylist(id);
    if (session.playlistTracks.length) {
      session.playAll(session.playlistTracks);
    }
  }

  function onRenameBlur() {
    if (!activePlaylist) return;
    const next = renameDraft.trim();
    if (!next || next === activePlaylist.name) return;
    void session.renamePlaylist(activePlaylist.id, next);
  }
</script>

<div class="view-page playlists-page">
  <header class="view-page__toolbar-band">
    <section class="rk-surface-card surface-card--toolbar-only">
      <div class="section-head section-head--page-toolbar page-toolbar">
        <SectionHeadLead eyebrow="Playlist" title="Collezioni personali">
          <UiIcon name="queueMusic" class="section-head__ic" />
        </SectionHeadLead>
        <div class="section-head__tools page-toolbar__actions">
          <div class="hero-card__actions queue-hero-actions">
            <input
              class="ghost-input queue-name-input"
              bind:value={session.newPlaylistName}
              placeholder="Nuova playlist"
              aria-label="Nuova playlist"
            />
            <button
              type="button"
              class="primary-btn"
              onclick={() => void session.createPlaylist()}
            >
              Crea
            </button>
          </div>
        </div>
      </div>
    </section>
  </header>

  <section class="playlists-page__main">
    <div class="view-stack">
      <section class="rk-surface-card">
        <div class="list-stack">
          {#if session.playlists.length === 0}
            <p class="panel-empty">Nessuna playlist — creane una qui sopra.</p>
          {/if}
          {#each session.playlists as pl (pl.id)}
            <div
              class="playlist-row"
              class:is-active={session.activePlaylistId === pl.id}
            >
              <button
                type="button"
                class="playlist-row__main"
                onclick={() => void session.openPlaylist(pl.id)}
              >
                <strong>{pl.name}</strong>
                <span>{pl.track_count} brani</span>
              </button>
              <div class="track-row__actions">
                <button
                  type="button"
                  class="chip-btn"
                  disabled={!pl.track_count}
                  onclick={() => void playPlaylist(pl.id)}
                >
                  Play
                </button>
                <button
                  type="button"
                  class="chip-btn"
                  disabled={!session.current}
                  onclick={() => void session.addCurrentToPlaylist(pl.id)}
                >
                  + Brano corrente
                </button>
                <button
                  type="button"
                  class="chip-btn danger"
                  onclick={() => {
                    if (
                      confirm(
                        `Eliminare la playlist «${pl.name}»? L'operazione non è reversibile.`,
                      )
                    ) {
                      void session.deletePlaylist(pl.id);
                    }
                  }}
                >
                  Elimina
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    </div>

    <div class="view-stack">
      {#if activePlaylist}
        <section class="rk-surface-card surface-card--toolbar-only">
          <div class="section-head section-head--page-toolbar">
            <SectionHeadLead eyebrow="Dettaglio playlist" title={activePlaylist.name}>
              <UiIcon name="queueMusic" class="section-head__ic" />
            </SectionHeadLead>
            <div class="section-head__tools page-toolbar__actions">
              <input
                class="ghost-input compact playlist-rename-input"
                bind:value={renameDraft}
                aria-label="Rinomina playlist"
                onblur={onRenameBlur}
              />
            </div>
          </div>
        </section>
        <section class="rk-surface-card">
          <TrackList
            tracks={session.playlistTracks}
            favoriteIds={session.favoriteIds}
            playlistOptions={session.playlistOptions}
            activeTrackId={session.current?.id ?? null}
            emptyMessage="Aggiungi il brano in riproduzione o salva una coda."
            onplay={(track, list) => session.playTrack(track, list)}
            ontoggleFavorite={(track) => void session.toggleFavorite(track)}
            onaddToPlaylist={(playlistId, track) =>
              void session.addToPlaylist(playlistId, track.id)}
            onremove={(track) =>
              void session.removeFromPlaylist(activePlaylist.id, track.id)}
          />
        </section>
      {:else}
        <section class="rk-surface-card">
          <p class="panel-empty">
            Seleziona una playlist per vederne contenuto e azioni.
          </p>
        </section>
      {/if}
    </div>
  </section>
</div>
