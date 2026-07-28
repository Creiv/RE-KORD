<script lang="ts">
  import { Button, Field, Modal, TextInput } from "@rekord/ui";
  import { albumCoverUrl } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import TrackMoodGlyph from "./TrackMoodGlyph.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import {
    GENRE_POOL,
    TRACK_MOOD_COLORS,
    TRACK_MOOD_IDS,
    TRACK_MOOD_LABELS,
    previewGenre,
    previewLabel,
    previewYear,
    resolveTrackMoods,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs, patchUserPrefs } from "../lib/userPrefs";

  let draftTitle = $state("");
  let draftMoods = $state<TrackMoodId[]>([]);
  let draftGenres = $state<string[]>([]);
  let draftRelease = $state("");
  let genreQuery = $state("");
  let genreListOpen = $state(false);

  $effect(() => {
    if (session.editDialog === "track" && session.editTrack) {
      const t = session.editTrack;
      draftTitle = t.title;
      draftMoods = resolveTrackMoods(t.id, t.rel_path, loadUserPrefs().trackMoods);
      const g = previewGenre(t.rel_path);
      draftGenres = g ? [g] : [];
      draftRelease = "";
      genreQuery = "";
      genreListOpen = false;
    }
  });

  function genreKey(raw: string): string {
    return raw.trim().toLocaleLowerCase("it");
  }

  function addGenre(genre: string) {
    const next = genre.trim();
    if (!next) return;
    const k = genreKey(next);
    if (draftGenres.some((g) => genreKey(g) === k)) return;
    draftGenres = [...draftGenres, next];
    genreQuery = "";
    genreListOpen = false;
  }

  function removeGenre(index: number) {
    draftGenres = draftGenres.filter((_, i) => i !== index);
  }

  const availableGenres = $derived(
    GENRE_POOL.filter((g) => !draftGenres.some((s) => genreKey(s) === genreKey(g))),
  );

  const filteredGenres = $derived.by(() => {
    const q = genreKey(genreQuery);
    if (!q) return availableGenres;
    return availableGenres.filter((g) => genreKey(g).includes(q));
  });

  const canAddGenre = $derived(
    genreQuery.trim().length > 0 &&
      !draftGenres.some((s) => genreKey(s) === genreKey(genreQuery)),
  );

  function toggleMood(id: TrackMoodId) {
    if (draftMoods.includes(id)) {
      draftMoods = draftMoods.filter((m) => m !== id);
      return;
    }
    if (draftMoods.length >= 3) return;
    draftMoods = [...draftMoods, id];
  }

  function saveTrackMoods() {
    const t = session.editTrack;
    if (!t) return;
    const trackMoods = { ...loadUserPrefs().trackMoods, [String(t.id)]: draftMoods };
    patchUserPrefs({ trackMoods });
    session.bumpMoodPrefs();
    session.closeEdit();
  }

  const albumSeed = $derived(
    session.selectedAlbum
      ? `${session.selectedAlbum.artist_name}/${session.selectedAlbum.name}`
      : "",
  );
</script>

<Modal
  open={session.editDialog === "track"}
  eyebrow="Metadati brano"
  title="Modifica dati brano"
  lede={session.editTrack?.rel_path ?? ""}
  onclose={() => session.closeEdit()}
>
  {#if session.editTrack}
    <Field label="Titolo (visualizzato)">
      <TextInput bind:value={draftTitle} autocomplete="off" />
    </Field>
    <Field label="Data uscita">
      <TextInput type="date" bind:value={draftRelease} />
    </Field>
    <div class="meta-field">
      <span class="meta-label">Generi</span>
      <div class="genre-chips" role="list">
        {#each draftGenres as g, i (g + i)}
          <span class="genre-chip" role="listitem">
            <span class="genre-chip__text">{g}</span>
            <button
              type="button"
              class="genre-chip__x"
              onclick={() => removeGenre(i)}
              aria-label="Rimuovi {g}"
            >
              <UiIcon name="close" class="genre-chip__x-ic" />
            </button>
          </span>
        {/each}
      </div>
      <div class="genre-search">
        <div class="genre-search__row">
          <TextInput
            class="genre-search__input"
            bind:value={genreQuery}
            placeholder="Cerca o scrivi un genere…"
            autocomplete="off"
            role="combobox"
            aria-expanded={genreListOpen}
            aria-autocomplete="list"
            onfocus={() => (genreListOpen = true)}
            oninput={() => (genreListOpen = true)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (canAddGenre) addGenre(genreQuery);
              }
            }}
          />
          <button
            type="button"
            class="genre-search__add"
            disabled={!canAddGenre}
            aria-label="Aggiungi genere"
            title="Aggiungi genere"
            onclick={() => addGenre(genreQuery)}
          >
            <UiIcon name="add" class="genre-search__add-ic" />
          </button>
        </div>
        {#if genreListOpen && (filteredGenres.length > 0 || genreQuery.trim())}
          {#if filteredGenres.length > 0}
            <ul class="genre-search__list rk-scroll" role="listbox" aria-label="Aggiungi da libreria">
              {#each filteredGenres as g (g)}
                <li>
                  <button
                    type="button"
                    class="genre-search__option"
                    role="option"
                    aria-selected="false"
                    onclick={() => addGenre(g)}
                  >
                    {g}
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="genre-search__empty">
              {canAddGenre
                ? "Nessun genere in libreria corrisponde — usa + per aggiungerne uno nuovo"
                : "Nessun altro genere in libreria da aggiungere"}
            </p>
          {/if}
        {/if}
      </div>
    </div>
    <div class="meta-field">
      <span class="meta-label">Mood</span>
      <div class="mood-grid" role="group" aria-label="Mood">
        {#each TRACK_MOOD_IDS as id}
          {@const on = draftMoods.includes(id)}
          <button
            type="button"
            class="mood-btn"
            class:on
            style="--mood-c: {TRACK_MOOD_COLORS[id]}"
            aria-pressed={on}
            title={TRACK_MOOD_LABELS[id]}
            onclick={() => toggleMood(id)}
          >
            <TrackMoodGlyph mood={id} inheritColor />
          </button>
        {/each}
      </div>
    </div>
    <div class="meta-field lyrics-row">
      <span class="meta-label">Lyrics</span>
      <div class="lyrics-actions">
        <Button variant="ghost" class="lyrics-btn" disabled>Modifica</Button>
        <Button variant="ghost" class="lyrics-btn" disabled>Auto LRC</Button>
        <span
          class="lyrics-dot lyrics-dot--idle"
          title="AUTO LRC non eseguito"
          aria-label="AUTO LRC non eseguito"
        ></span>
      </div>
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" class="danger" disabled>Elimina file</Button>
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button variant="ghost" onclick={() => session.closeEdit()}>Annulla</Button>
    <Button onclick={saveTrackMoods}>Salva</Button>
  {/snippet}
</Modal>

<Modal
  open={session.editDialog === "album"}
  eyebrow="Metadati album"
  title={session.selectedAlbum?.name ?? "Album"}
  lede={session.selectedAlbum?.folder_key ?? ""}
  onclose={() => session.closeEdit()}
>
  {#if session.selectedAlbum}
    {@const a = session.selectedAlbum}
    <Field label="Titolo">
      <TextInput value={a.name} readonly />
    </Field>
    <Field label="Artista">
      <TextInput value={a.artist_name} readonly />
    </Field>
    <Field label="Data rilascio">
      <TextInput value={previewYear(albumSeed) ?? "—"} readonly />
    </Field>
    <Field label="Label">
      <TextInput value={previewLabel(albumSeed) ?? "—"} readonly />
    </Field>
    <Field label="Paese">
      <TextInput value="—" readonly />
    </Field>
    <Field label="Discogs">
      <TextInput value="— (in arrivo)" readonly />
    </Field>
    <Field label="Brani">
      <TextInput value={String(a.track_count)} readonly />
    </Field>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" disabled>Elimina cartella</Button>
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button variant="ghost" onclick={() => session.closeEdit()}>Chiudi</Button>
    <Button disabled>Salva</Button>
  {/snippet}
</Modal>

<Modal
  open={session.editDialog === "cover"}
  eyebrow="Cover album"
  title={session.selectedAlbum?.name ?? "Cover"}
  onclose={() => session.closeEdit()}
>
  {#if session.selectedAlbum}
    <div class="cover-preview">
      {#if session.selectedAlbum.has_cover}
        <img src={albumCoverUrl(session.selectedAlbum.id)} alt="" />
      {:else}
        <div class="ph">Nessuna cover su disco</div>
      {/if}
    </div>
    <p class="hint">
      Upload e modifica cover arriveranno senza Studio download. Dropzone disabilitata.
    </p>
    <div class="drop" aria-disabled="true">Trascina cover.jpg qui…</div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => session.closeEdit()}>Chiudi</Button>
    <Button disabled>Carica</Button>
  {/snippet}
</Modal>

<style>
  .meta-field {
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    font-size: 0.86rem;
  }

  .meta-label {
    color: var(--rk-muted);
    font-weight: 600;
  }

  .genre-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.15rem;
    min-width: 0;
  }

  .genre-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    max-width: 100%;
    padding: 0.2rem 0.2rem 0.2rem 0.5rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-3) 92%, var(--rk-line) 8%);
    font-size: 0.84rem;
    color: var(--rk-ink);
  }

  .genre-chip__text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 14rem;
  }

  .genre-chip__x {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    min-height: 1.5rem;
    border: none;
    border-radius: var(--rk-radius-sm);
    background: transparent;
    color: var(--rk-muted);
    cursor: pointer;
    padding: 0;
  }

  .genre-chip__x:hover {
    color: var(--rk-ink);
    background: color-mix(in srgb, var(--rk-line) 35%, transparent);
  }

  :global(.genre-chip__x-ic) {
    width: 1rem;
    height: 1rem;
    display: block;
  }

  .genre-search {
    position: relative;
    min-width: 0;
  }

  .genre-search__row {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
  }

  .genre-search__row :global(.genre-search__input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .genre-search__add {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.55rem;
    min-height: 2.55rem;
    padding: 0;
    border-radius: var(--rk-radius);
    border: 1px solid color-mix(in srgb, var(--rk-accent) 32%, var(--rk-line) 68%);
    background: color-mix(in srgb, var(--rk-accent) 10%, var(--rk-surface-3) 90%);
    color: var(--rk-accent);
    cursor: pointer;
  }

  .genre-search__add:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rk-accent) 16%, var(--rk-surface-3) 84%);
    border-color: color-mix(in srgb, var(--rk-accent) 44%, var(--rk-line) 56%);
  }

  .genre-search__add:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }

  :global(.genre-search__add-ic) {
    width: 1.05rem;
    height: 1.05rem;
    display: block;
  }

  .genre-search__list {
    position: absolute;
    z-index: 4;
    left: 0;
    right: 0;
    top: calc(100% + 0.35rem);
    max-height: 10rem;
    overflow: auto;
    margin: 0;
    padding: 0.25rem 0;
    list-style: none;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
    box-shadow: var(--rk-shadow-2);
  }

  .genre-search__option {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.45rem 0.65rem;
    border: none;
    background: transparent;
    color: var(--rk-ink);
    font: inherit;
    font-size: 0.84rem;
    cursor: pointer;
  }

  .genre-search__option:hover {
    background: color-mix(in srgb, var(--rk-accent) 10%, var(--rk-surface-3) 90%);
  }

  .genre-search__empty {
    position: absolute;
    z-index: 4;
    left: 0;
    right: 0;
    top: calc(100% + 0.35rem);
    margin: 0;
    padding: 0.55rem 0.65rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
    color: var(--rk-muted);
    font-size: 0.82rem;
  }

  .mood-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 0.4rem;
    margin-top: 0.1rem;
    max-width: 100%;
  }

  .mood-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.35rem;
    padding: 0.3rem;
    border-radius: var(--rk-radius);
    cursor: pointer;
    line-height: 0;
    --mood-c: var(--rk-muted);
    opacity: 0.3;
    border: 1px solid color-mix(in srgb, var(--rk-line) 82%, var(--mood-c) 18%);
    background: color-mix(in srgb, var(--rk-surface-2) 97%, var(--rk-muted) 3%);
    color: color-mix(in srgb, var(--rk-muted) 58%, var(--mood-c) 42%);
    filter: grayscale(0.55) brightness(0.9);
    box-shadow: none;
  }

  .mood-btn:hover:not(.on) {
    opacity: 0.52;
    border-color: color-mix(in srgb, var(--rk-line) 58%, var(--mood-c) 42%);
    background: color-mix(in srgb, var(--mood-c) 9%, var(--rk-surface-2) 91%);
    color: color-mix(in srgb, var(--mood-c) 65%, var(--rk-muted) 35%);
    filter: grayscale(0.22) brightness(0.98);
  }

  .mood-btn :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
    display: block;
  }

  .mood-btn.on {
    opacity: 1;
    filter: none;
    border: 1px solid color-mix(in srgb, var(--mood-c) 68%, var(--rk-line) 32%);
    background: color-mix(in srgb, var(--mood-c) 36%, var(--rk-surface-2) 64%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--mood-c) 35%, transparent);
    color: color-mix(in srgb, var(--mood-c) 96%, #000);
  }

  .mood-btn.on:hover {
    border-color: color-mix(in srgb, var(--mood-c) 75%, var(--rk-line) 25%);
    filter: brightness(1.04);
  }

  .lyrics-row {
    margin-top: -0.05rem;
  }

  .lyrics-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }

  .lyrics-actions :global(.lyrics-btn) {
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
  }

  .lyrics-dot {
    width: 0.72rem;
    height: 0.72rem;
    border-radius: 999px;
    border: 1px solid transparent;
    display: inline-block;
    flex: 0 0 auto;
  }

  .lyrics-dot--idle {
    background: color-mix(in srgb, var(--rk-muted) 35%, transparent);
    border-color: color-mix(in srgb, var(--rk-muted) 45%, transparent);
  }

  :global(.rk-btn.danger) {
    color: var(--rk-danger);
    border-color: color-mix(in srgb, var(--rk-danger) 55%, var(--rk-line) 45%);
  }

  .hint {
    margin: 0.35rem 0 0;
    color: var(--rk-muted);
    font-size: 0.82rem;
  }

  .cover-preview {
    width: 180px;
    height: 180px;
    border-radius: var(--rk-radius-lg);
    overflow: hidden;
    border: 1px solid var(--rk-line);
  }

  .cover-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background: var(--rk-surface-3);
    color: var(--rk-muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 0.5rem;
  }

  .drop {
    border: 1px dashed var(--rk-line-strong);
    border-radius: var(--rk-radius);
    padding: 1.25rem;
    text-align: center;
    color: var(--rk-muted);
    opacity: 0.65;
  }

  @media (max-width: 560px) {
    .mood-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
</style>
