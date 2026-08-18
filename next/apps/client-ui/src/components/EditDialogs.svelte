<script lang="ts">
  import { Button, Field, Modal, TextInput } from "@rekord/ui";
  import { albumCoverUrl, api } from "../lib/api";
  import { runAutoLrcQuickSaveForTrack } from "../lib/autoLrc";
  import { parseTrackGenres, serializeTrackGenres } from "../lib/genres";
  import { t } from "../lib/i18n.svelte";
  import { session } from "../lib/session.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import {
    resolveTrackLyricsDotStatus,
    type TrackLyricsEphemeralAutoStatus,
  } from "../lib/trackLyricsDotStatus";
  import TrackMoodGlyph from "./TrackMoodGlyph.svelte";
  import UiIcon from "./icons/UiIcon.svelte";
  import {
    GENRE_POOL,
    TRACK_MOOD_COLORS,
    TRACK_MOOD_IDS,
    TRACK_MOOD_LABELS,
    resolveTrackMoods,
    toDateInputValue,
    type TrackMoodId,
  } from "../lib/trackMoods";
  import { loadUserPrefs, patchUserPrefs } from "../lib/userPrefs";

  let draftTitle = $state("");
  let draftMoods = $state<TrackMoodId[]>([]);
  let draftGenres = $state<string[]>([]);
  let draftRelease = $state("");
  let draftLyrics = $state("");
  let lyricsOpen = $state(false);
  let lyricsDraft = $state("");
  let lyricsErr = $state("");
  let lyricsFetchBusy = $state(false);
  let autoLrcBusy = $state(false);
  let autoLrcStatus = $state<TrackLyricsEphemeralAutoStatus>("idle");
  let genreQuery = $state("");
  let genreListOpen = $state(false);
  let busy = $state(false);
  let editError = $state("");
  let deleteAsk = $state(false);
  let deleteBusy = $state(false);
  let draftAlbumTitle = $state("");
  let draftAlbumRelease = $state("");
  let draftAlbumLabel = $state("");
  let draftAlbumCountry = $state("");
  let coverFile = $state<File | null>(null);

  $effect(() => {
    // Reopening a dialog must never land on an armed delete button.
    if (session.editDialog) {
      deleteAsk = false;
      deleteBusy = false;
    }
    if (session.editDialog === "track" && session.editTrack) {
      const tr = session.editTrack;
      draftTitle = tr.title;
      draftMoods = resolveTrackMoods(tr.id, tr.rel_path, loadUserPrefs().trackMoods);
      draftGenres = parseTrackGenres(tr.genre);
      draftRelease = toDateInputValue(tr.release_date);
      draftLyrics = tr.lyrics ?? "";
      lyricsOpen = false;
      lyricsDraft = "";
      lyricsErr = "";
      autoLrcStatus = "idle";
      genreQuery = "";
      genreListOpen = false;
      editError = "";
    }
    if (session.editDialog === "album" && session.selectedAlbum) {
      const a = session.selectedAlbum;
      draftAlbumTitle = a.name;
      draftAlbumRelease = toDateInputValue(a.release_date);
      draftAlbumLabel = a.label ?? "";
      draftAlbumCountry = a.country ?? "";
      editError = "";
    }
    if (session.editDialog === "cover") {
      coverFile = null;
      editError = "";
    }
  });

  const lyricsDotStatus = $derived(
    resolveTrackLyricsDotStatus({
      lyricsText: draftLyrics,
      fetchBusy: autoLrcBusy || lyricsFetchBusy,
      ephemeralAutoStatus: autoLrcStatus,
    }),
  );

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

  async function saveTrack() {
    const tr = session.editTrack;
    if (!tr || busy) return;
    busy = true;
    editError = "";
    try {
      const genre = serializeTrackGenres(draftGenres);
      const releaseDate = draftRelease.trim();
      await api.trackInfoSave(tr.rel_path, {
        title: draftTitle.trim() || tr.title,
        genre: genre ?? "",
        releaseDate: releaseDate || undefined,
        lyrics: draftLyrics,
      });
      const prev = { ...loadUserPrefs().trackMoods };
      // Chiave stabile = rel_path (parity legacy / sopravvive al re-scan).
      delete prev[String(tr.id)];
      const trackMoods = { ...prev, [tr.rel_path]: draftMoods };
      patchUserPrefs({ trackMoods });
      session.bumpMoodPrefs();
      tr.title = draftTitle.trim() || tr.title;
      tr.genre = genre;
      if (releaseDate) tr.release_date = releaseDate;
      tr.lyrics = draftLyrics || null;
      const cat = session.catalogTracks.find((c) => c.rel_path === tr.rel_path);
      if (cat) {
        cat.genre = genre;
        cat.lyrics = tr.lyrics;
      }
      const inAlbum = session.tracks.find((c) => c.rel_path === tr.rel_path);
      if (inAlbum && inAlbum !== tr) {
        inAlbum.genre = genre;
        inAlbum.lyrics = tr.lyrics;
      }
      session.tick += 1;
      session.closeEdit();
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function openLyricsDialog() {
    lyricsDraft = draftLyrics;
    lyricsErr = "";
    lyricsOpen = true;
  }

  function cancelLyricsDialog() {
    lyricsOpen = false;
    lyricsErr = "";
  }

  async function saveLyricsDialog() {
    const tr = session.editTrack;
    if (!tr || busy || lyricsFetchBusy) return;
    busy = true;
    lyricsErr = "";
    try {
      await api.trackInfoSave(tr.rel_path, { lyrics: lyricsDraft });
      draftLyrics = lyricsDraft;
      tr.lyrics = lyricsDraft || null;
      const cat = session.catalogTracks.find((c) => c.rel_path === tr.rel_path);
      if (cat) cat.lyrics = tr.lyrics;
      session.tick += 1;
      lyricsOpen = false;
    } catch (e) {
      lyricsErr = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** Subdialog: fetch LRCLIB into textarea (no auto-save). */
  async function fetchLyricsIntoDialog() {
    const tr = session.editTrack;
    if (!tr || lyricsFetchBusy || busy) return;
    lyricsFetchBusy = true;
    lyricsErr = "";
    try {
      const fetched = await api.trackLyricsFetch(tr.rel_path);
      const synced = String(fetched.syncedLyrics || "").trim();
      const plain = String(fetched.plainLyrics || "").trim();
      const next = synced || plain;
      if (!next) {
        lyricsErr = t("trackMeta.fetchLrcEmpty");
        return;
      }
      lyricsDraft = next;
      if (!synced && plain) lyricsErr = t("trackMeta.fetchLrcPlainFound");
    } catch (e) {
      lyricsErr = e instanceof Error ? e.message : String(e);
    } finally {
      lyricsFetchBusy = false;
    }
  }

  /** Main dialog: Auto LRC quick-save (fetch + persist). */
  async function runAutoLrcQuickSave() {
    const tr = session.editTrack;
    if (!tr || busy || autoLrcBusy || lyricsFetchBusy) return;
    autoLrcBusy = true;
    editError = "";
    autoLrcStatus = "idle";
    try {
      const result = await runAutoLrcQuickSaveForTrack(tr);
      autoLrcStatus = result.status;
      if (result.status === "missing") {
        editError = t("trackMeta.fetchLrcEmpty");
        return;
      }
      draftLyrics = result.lyrics ?? "";
      if (result.status === "okPlain") editError = t("trackMeta.fetchLrcPlainFound");
      const cat = session.catalogTracks.find((c) => c.rel_path === tr.rel_path);
      if (cat) cat.lyrics = tr.lyrics;
      session.tick += 1;
    } catch (e) {
      autoLrcStatus = "error";
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      autoLrcBusy = false;
    }
  }

  async function saveAlbum() {
    const a = session.selectedAlbum;
    if (!a || busy) return;
    busy = true;
    editError = "";
    try {
      const releaseDate = draftAlbumRelease.trim();
      const label = draftAlbumLabel.trim();
      const country = draftAlbumCountry.trim();
      await api.albumInfoSave(a.folder_key, {
        title: draftAlbumTitle.trim() || a.name,
        releaseDate: releaseDate || undefined,
        label: label || undefined,
        country: country || undefined,
      });
      a.name = draftAlbumTitle.trim() || a.name;
      if (releaseDate) a.release_date = releaseDate;
      a.label = label || null;
      a.country = country || null;
      a.has_album_meta = true;
      session.closeEdit();
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Deleting is a machine operation: from a phone on the LAN the hub answers
   * 403 unless remote admin is on, and the message says so.
   */
  async function deleteTrackFromDisk() {
    const tr = session.editTrack;
    if (!tr || deleteBusy) return;
    deleteBusy = true;
    editError = "";
    try {
      const res = await api.deleteTrackFiles([tr.rel_path]);
      if (!res.deleted.length) {
        editError = t("trackMeta.deleteFailed");
        return;
      }
      session.closeEdit();
      toasts.ok(t("trackMeta.deleteDone", { title: tr.title }));
      await session.forgetDeletedTracks(res.deleted, [tr.id]);
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      deleteBusy = false;
      deleteAsk = false;
    }
  }

  async function deleteAlbumFromDisk() {
    const a = session.selectedAlbum;
    if (!a || deleteBusy) return;
    deleteBusy = true;
    editError = "";
    try {
      const res = await api.deleteAlbumFolder(a.folder_key);
      if (!res.deleted.length) {
        editError = t("albumMeta.deleteFailed");
        return;
      }
      const goneIds = session.tracks
        .filter((tr) => res.deleted.includes(tr.rel_path))
        .map((tr) => tr.id);
      session.closeEdit();
      toasts.ok(t("albumMeta.deleteDone", { name: a.name }));
      await session.forgetDeletedTracks(res.deleted, goneIds);
      // Its page is now a dead end.
      if (session.selectedAlbum?.folder_key === res.deletedFolder) {
        await session.backLibrary();
      }
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      deleteBusy = false;
      deleteAsk = false;
    }
  }

  async function uploadCover() {
    const a = session.selectedAlbum;
    if (!a || !coverFile || busy) return;
    busy = true;
    editError = "";
    try {
      await api.artworkUpload(a.folder_key, coverFile);
      a.has_cover = true;
      session.closeEdit();
    } catch (e) {
      editError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const albumSeed = $derived(
    session.selectedAlbum
      ? `${session.selectedAlbum.artist_name}/${session.selectedAlbum.name}`
      : "",
  );

  const albumHasDiscogs = $derived.by(() => {
    const a = session.selectedAlbum;
    if (!a) return false;
    return Boolean(a.discogs_release_id || a.discogs_uri || a.discogs_extra);
  });

  const albumDiscogsUri = $derived.by(() => {
    const a = session.selectedAlbum;
    if (!a) return "";
    const uri = (a.discogs_uri || a.discogs_extra?.discogsUri || "").trim();
    if (uri) return uri;
    const id = String(a.discogs_release_id || "").trim();
    return id ? `https://www.discogs.com/release/${id}` : "";
  });
</script>

<Modal
  open={session.editDialog === "track"}
  eyebrow={t("trackMeta.editEyebrow")}
  title={t("trackMeta.editHeading")}
  lede={session.editTrack?.rel_path ?? ""}
  onclose={() => {
    if (lyricsOpen) return;
    session.closeEdit();
  }}
>
  {#if session.editTrack}
    <Field label={t("trackMeta.fieldTitle")}>
      <TextInput bind:value={draftTitle} autocomplete="off" />
    </Field>
    <Field label={t("trackMeta.fieldReleaseDate")}>
      <TextInput type="date" bind:value={draftRelease} />
    </Field>
    <div class="meta-field">
      <span class="meta-label">{t("trackMeta.fieldGenre")}</span>
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
      <span class="meta-label">{t("trackMeta.fieldMood")}</span>
      <div class="mood-grid" role="group" aria-label={t("trackMeta.fieldMood")}>
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
      <span class="meta-label">{t("trackMeta.fieldLyrics")}</span>
      <div class="lyrics-actions">
        <Button
          variant="ghost"
          class="lyrics-btn"
          disabled={busy || autoLrcBusy || lyricsFetchBusy}
          onclick={openLyricsDialog}>{t("trackMeta.lyricsEditBtn")}</Button
        >
        <Button
          variant="ghost"
          class="lyrics-btn"
          disabled={busy || autoLrcBusy || lyricsFetchBusy}
          onclick={() => void runAutoLrcQuickSave()}
          >{autoLrcBusy ? t("trackMeta.fetchLrcBusy") : t("trackMeta.fetchLrc")}</Button
        >
        <span
          class="lyrics-dot lyrics-dot--{lyricsDotStatus}"
          title={t(`trackMeta.lyricsAutoStatus.${lyricsDotStatus}`)}
          aria-label={t(`trackMeta.lyricsAutoStatus.${lyricsDotStatus}`)}
        ></span>
      </div>
    </div>
    {#if deleteAsk}
      <div class="meta-danger" role="alert">
        <p class="meta-danger__text">{t("trackMeta.deleteWarn")}</p>
        <p class="meta-danger__path">{session.editTrack.rel_path}</p>
        <div class="meta-danger__actions">
          <Button variant="ghost" disabled={deleteBusy} onclick={() => (deleteAsk = false)}
            >{t("trackMeta.editCancel")}</Button
          >
          <Button tone="danger" disabled={deleteBusy} onclick={() => void deleteTrackFromDisk()}
            >{deleteBusy ? t("trackMeta.deleteBusy") : t("trackMeta.deleteConfirm")}</Button
          >
        </div>
      </div>
    {/if}
    {#if editError}<p class="warnline" role="alert">{editError}</p>{/if}
  {/if}
  {#snippet footer()}
    {#if session.editTrack && session.canManageMachine && !deleteAsk}
      <Button
        variant="ghost"
        tone="danger"
        disabled={busy || autoLrcBusy || deleteBusy}
        onclick={() => (deleteAsk = true)}>{t("trackMeta.delete")}</Button
      >
    {/if}
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button variant="ghost" onclick={() => session.closeEdit()}>{t("trackMeta.editCancel")}</Button>
    <Button disabled={busy || autoLrcBusy || deleteBusy} onclick={() => void saveTrack()}
      >{busy ? t("trackMeta.editSaving") : t("trackMeta.editSave")}</Button
    >
  {/snippet}
</Modal>

<Modal
  open={lyricsOpen && session.editDialog === "track"}
  eyebrow={t("trackMeta.fieldLyrics")}
  title={t("trackMeta.editLyrics")}
  panelClass="meta-edit-lyrics-dialog"
  onclose={cancelLyricsDialog}
>
  <textarea
    class="lyrics-editor lyrics-editor--dialog"
    rows="14"
    bind:value={lyricsDraft}
    placeholder={t("trackMeta.lyricsPlaceholder")}
  ></textarea>
  {#if lyricsErr}<p class="warnline" role="alert">{lyricsErr}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" disabled={busy || lyricsFetchBusy} onclick={cancelLyricsDialog}
      >{t("trackMeta.editCancel")}</Button
    >
    <Button
      variant="ghost"
      disabled={busy || lyricsFetchBusy}
      onclick={() => void fetchLyricsIntoDialog()}
      >{lyricsFetchBusy ? t("trackMeta.fetchLrcBusy") : t("trackMeta.fetchLrc")}</Button
    >
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button disabled={busy || lyricsFetchBusy} onclick={() => void saveLyricsDialog()}
      >{busy ? t("trackMeta.editSaving") : t("trackMeta.saveLyrics")}</Button
    >
  {/snippet}
</Modal>

<Modal
  open={session.editDialog === "album"}
  eyebrow={t("albumMeta.editEyebrow")}
  title={t("albumMeta.editHeading")}
  lede={session.selectedAlbum?.folder_key ?? ""}
  onclose={() => session.closeEdit()}
>
  {#if session.selectedAlbum}
    {@const a = session.selectedAlbum}
    <Field label={t("albumMeta.fieldTitle")}>
      <TextInput bind:value={draftAlbumTitle} autocomplete="off" />
    </Field>
    <Field label={t("albumMeta.fieldReleaseDate")}>
      <TextInput type="date" bind:value={draftAlbumRelease} />
    </Field>
    <Field label={t("albumMeta.fieldLabel")}>
      <TextInput bind:value={draftAlbumLabel} autocomplete="off" />
    </Field>
    <Field label={t("albumMeta.fieldCountry")}>
      <TextInput bind:value={draftAlbumCountry} autocomplete="off" />
    </Field>
    <Field label={t("albumMeta.fieldTrackCount")}>
      <TextInput value={String(a.track_count)} readonly />
    </Field>
    {#if albumHasDiscogs}
      <div class="meta-edit-discogs">
        <p class="meta-edit-discogs__eyebrow">{t("albumMeta.discogsSection")}</p>
        {#if a.discogs_extra?.formatSummary}
          <p>
            {t("albumMeta.discogsFormat")}: {a.discogs_extra.formatSummary}
          </p>
        {/if}
        {#if a.discogs_extra?.catalogNo}
          <p>
            {t("albumMeta.discogsCatalog")}: {a.discogs_extra.catalogNo}
          </p>
        {/if}
        {#if a.discogs_release_id}
          <p>
            {t("albumMeta.discogsReleaseId")}: {a.discogs_release_id}
          </p>
        {/if}
        {#if albumDiscogsUri}
          <p>
            <a href={albumDiscogsUri} target="_blank" rel="noopener noreferrer">
              {t("albumMeta.discogsOpen")}
            </a>
          </p>
        {/if}
      </div>
    {/if}
    {#if deleteAsk}
      <div class="meta-danger" role="alert">
        <p class="meta-danger__text">
          {t("albumMeta.deleteWarn", { count: a.track_count })}
        </p>
        <p class="meta-danger__path">{a.folder_key}</p>
        <div class="meta-danger__actions">
          <Button variant="ghost" disabled={deleteBusy} onclick={() => (deleteAsk = false)}
            >{t("trackMeta.editCancel")}</Button
          >
          <Button tone="danger" disabled={deleteBusy} onclick={() => void deleteAlbumFromDisk()}
            >{deleteBusy ? t("trackMeta.deleteBusy") : t("albumMeta.deleteConfirm")}</Button
          >
        </div>
      </div>
    {/if}
    {#if editError}<p class="warnline" role="alert">{editError}</p>{/if}
  {/if}
  {#snippet footer()}
    {#if session.selectedAlbum && !session.selectedAlbum.loose && session.canManageMachine && !deleteAsk}
      <Button
        variant="ghost"
        tone="danger"
        disabled={busy || deleteBusy}
        onclick={() => (deleteAsk = true)}>{t("albumMeta.delete")}</Button
      >
    {/if}
    <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
    <Button variant="ghost" onclick={() => session.closeEdit()}>{t("trackMeta.editCancel")}</Button>
    <Button disabled={busy || deleteBusy} onclick={() => void saveAlbum()}
      >{busy ? t("trackMeta.editSaving") : t("trackMeta.editSave")}</Button
    >
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
    <p class="hint">Carica un JPEG/PNG/WebP come cover.jpg nella cartella album.</p>
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      onchange={(e) => {
        const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
        coverFile = f;
      }}
    />
    {#if editError}<p class="warnline" role="alert">{editError}</p>{/if}
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => session.closeEdit()}>Chiudi</Button>
    <Button disabled={busy || !coverFile} onclick={() => void uploadCover()}>Carica</Button>
  {/snippet}
</Modal>

<style>
  .meta-field {
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    font-size: var(--rk-fs-sm);
  }

  .meta-label {
    color: var(--rk-muted);
    font-weight: 600;
  }

  .meta-danger {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    border-radius: var(--rk-radius-sm);
    border: 1px solid color-mix(in srgb, var(--rk-danger) 55%, var(--rk-line) 45%);
    background: var(--rk-danger-soft);
  }

  .meta-danger__text {
    margin: 0;
    font-size: var(--rk-fs-sm);
    font-weight: 600;
    color: var(--rk-danger);
  }

  .meta-danger__path {
    margin: 0;
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    overflow-wrap: anywhere;
  }

  .meta-danger__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    justify-content: flex-end;
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
    font-size: var(--rk-fs-sm);
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
      overscroll-behavior: contain;
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
    font-size: var(--rk-fs-sm);
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
    font-size: var(--rk-fs-sm);
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
    border-radius: var(--rk-radius-round);
    border: 1px solid transparent;
    display: inline-block;
    flex: 0 0 auto;
  }

  .lyrics-dot--idle {
    background: color-mix(in srgb, var(--rk-muted) 35%, transparent);
    border-color: color-mix(in srgb, var(--rk-muted) 45%, transparent);
  }

  .lyrics-dot--busy {
    background: color-mix(in srgb, var(--rk-accent) 55%, transparent);
    border-color: color-mix(in srgb, var(--rk-accent) 65%, transparent);
    animation: lyrics-dot-pulse 0.9s ease-in-out infinite;
  }

  .lyrics-dot--okLrc {
    background: color-mix(in srgb, #22c55e 70%, transparent);
    border-color: color-mix(in srgb, #22c55e 80%, transparent);
  }

  .lyrics-dot--okPlain {
    background: color-mix(in srgb, #3b82f6 70%, transparent);
    border-color: color-mix(in srgb, #3b82f6 80%, transparent);
  }

  .lyrics-dot--missing {
    background: color-mix(in srgb, #eab308 70%, transparent);
    border-color: color-mix(in srgb, #eab308 80%, transparent);
  }

  .lyrics-dot--error {
    background: color-mix(in srgb, var(--rk-danger) 70%, transparent);
    border-color: color-mix(in srgb, var(--rk-danger) 80%, transparent);
  }

  @keyframes lyrics-dot-pulse {
    50% {
      opacity: 0.45;
    }
  }

  .hint {
    margin: 0.35rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
  }

  .meta-edit-discogs {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: 0.15rem 0 0.25rem;
    padding: 0.55rem 0.65rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-2) 88%, transparent);
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh-snug);
  }

  .meta-edit-discogs__eyebrow {
    margin: 0 0 0.1rem;
    font-size: var(--rk-fs-3xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rk-muted);
  }

  .meta-edit-discogs p {
    margin: 0;
  }

  .meta-edit-discogs a {
    color: var(--rk-accent, var(--rk-fg));
    text-decoration: underline;
    text-underline-offset: 0.12em;
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
    font-size: var(--rk-fs-sm);
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

  .lyrics-editor {
    width: 100%;
    min-height: 7rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    background: var(--rk-surface-3);
    color: var(--rk-ink);
    font: inherit;
    padding: 0.5rem 0.65rem;
    resize: vertical;
  }

  .lyrics-editor--dialog {
    min-height: 16rem;
    font-family: var(--rk-mono, ui-monospace, monospace);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  /* Il testo di una canzone si legge meglio largo — ma solo dove il dialogo è un
     pannello: sul telefono è un foglio a tutta larghezza e non va ristretto. */
  @media (min-width: 1000px) {
    :global(.meta-edit-lyrics-dialog) {
      max-width: min(42rem, 96vw);
    }
  }

  .warnline {
    color: var(--rk-warn, #f59e0b);
    font-size: var(--rk-fs-sm);
  }

  @media (max-width: 559.98px) {
    .mood-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
</style>
