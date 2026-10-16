<script lang="ts">
  import { CoverArt, EmptyState, FileDrop } from "@rekord/ui";
  import { onMount, untrack } from "svelte";
  import { albumCoverUrl, api, coverUrlFor, type ArtworkHit } from "../../lib/api";
  import { i18n, t } from "../../lib/i18n.svelte";
  import { session } from "../../lib/session.svelte";
  import { studioAccess } from "../../lib/studio/access.svelte";
  import { studioFocus, takeStudioAlbum } from "../../lib/studio/focus.svelte";
  import { studioCodeText, studioErrorText } from "../../lib/studio/errors";
  import StudioAccessNotice from "./StudioAccessNotice.svelte";

  /** Same cap as the hub (`metadata::artwork::MAX_IMAGE_BYTES`). */
  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

  let coverArtistId = $state<number | null>(null);
  let coverAlbumId = $state<number | null>(null);
  let artQuery = $state("");
  let results = $state<ArtworkHit[]>([]);
  let searched = $state(false);
  let busy = $state(false);
  let applying = $state<string | null>(null);
  let err = $state<string | null>(null);
  let msg = $state<string | null>(null);
  /** Providers that failed during the last search (results may be partial). */
  let sourceErrors = $state<string[]>([]);
  /**
   * Cache-buster per album after an apply/upload: the hub serves covers with a
   * long max-age, so the same URL would keep showing the old image.
   */
  let coverVersions = $state<Record<number, string | number>>({});

  const canWrite = $derived(studioAccess.canWrite);
  const writeTitle = $derived(studioAccess.reason ?? undefined);

  const artistsSorted = $derived(
    session.artists.slice().sort((a, b) => a.name.localeCompare(b.name, i18n.sortLocale)),
  );
  const coverArtist = $derived(
    coverArtistId != null ? (session.artists.find((a) => a.id === coverArtistId) ?? null) : null,
  );
  const coverAlbums = $derived(
    coverArtist
      ? session.allAlbums
          .filter(
            (a) =>
              !a.loose &&
              (a.artist_id === coverArtist.id ||
                (a.artist_id == null && a.artist_name === coverArtist.name)),
          )
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, i18n.sortLocale, { numeric: true }))
      : [],
  );
  const selectedAlbum = $derived(
    coverAlbumId != null ? (coverAlbums.find((a) => a.id === coverAlbumId) ?? null) : null,
  );

  function versioned(url: string, v: string | number | undefined): string {
    if (!v) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(v))}`;
  }

  const currentCoverSrc = $derived.by(() => {
    const al = selectedAlbum;
    if (!al) return "";
    const v = coverVersions[al.id];
    // A cover changed here wins; otherwise the hub's own `?v=` (or none).
    if (v) return versioned(albumCoverUrl(al.id, 256), v);
    return coverUrlFor(al, 256) ?? "";
  });

  function fillFromPlayback() {
    const cur = session.current;
    if (!cur) return;
    const byId = cur.artist_id != null ? session.artists.find((a) => a.id === cur.artist_id) : null;
    coverArtistId = (byId ?? session.artists.find((a) => a.name === cur.artist_name))?.id ?? null;
    coverAlbumId = cur.album_id;
    artQuery = `${cur.artist_name} ${cur.album_name}`;
  }

  /** Opened from the dashboard's "Da sistemare" list for one album. */
  const focusRequested = studioFocus.pane === "covers";
  let pendingAlbumId = $state<number | null>(null);

  onMount(() => {
    studioAccess.ensure();
    if (session.current && !focusRequested) fillFromPlayback();
  });

  $effect(() => {
    if (studioFocus.pane === "covers" && studioFocus.albumId != null) {
      pendingAlbumId = untrack(() => takeStudioAlbum("covers"));
    }
  });

  // Artists and albums may still be loading when the pane opens.
  $effect(() => {
    const id = pendingAlbumId;
    if (id == null) return;
    const al = session.allAlbums.find((a) => a.id === id);
    if (!al) return;
    const artist =
      (al.artist_id != null ? session.artists.find((a) => a.id === al.artist_id) : null) ??
      session.artists.find((a) => a.name === al.artist_name);
    if (!artist) return;
    untrack(() => {
      coverArtistId = artist.id;
      coverAlbumId = al.id;
      artQuery = `${al.artist_name} ${al.name}`;
      results = [];
      searched = false;
      err = null;
      msg = null;
      pendingAlbumId = null;
    });
  });

  async function search() {
    if (!selectedAlbum && !artQuery.trim()) {
      err = t("studio.covers.errPick");
      return;
    }
    busy = true;
    err = null;
    msg = null;
    try {
      const q =
        artQuery.trim() ||
        `${selectedAlbum?.artist_name ?? ""} ${selectedAlbum?.name ?? ""}`.trim();
      const r = await api.artworkSearch({
        q,
        artist: selectedAlbum?.artist_name || coverArtist?.name || undefined,
        album: selectedAlbum?.name || undefined,
      });
      results = r.results || [];
      const errs = (r as { errors?: Array<{ source?: string; code?: string; message?: string }> }).errors;
      sourceErrors = Array.isArray(errs)
        ? errs.map((e) => `${e.source ?? "?"}: ${studioCodeText(e.code ?? null, e.message ?? null)}`)
        : [];
      searched = true;
    } catch (e) {
      err = studioErrorText(e);
      results = [];
      searched = true;
    } finally {
      busy = false;
    }
  }

  /** Show the new cover at once, then reload albums so other views follow. */
  async function afterCoverChange(albumId: number, label: string, res: unknown) {
    // The hub's `coverVersion` is the album's new `cover_version` (the same on
    // every client); fall back to now for an older hub.
    const raw = (res as { coverVersion?: unknown } | null)?.coverVersion;
    const v = typeof raw === "string" || typeof raw === "number" ? raw : "";
    const version = v !== "" && v !== 0 ? v : Date.now();
    coverVersions = { ...coverVersions, [albumId]: version };
    // Player bar, queue, tiles and rows of this album show it at once.
    session.noteAlbumCoverChanged(albumId, version);
    msg = t("studio.covers.saved", { album: label });
    try {
      await session.loadAllAlbums();
    } catch {
      /* the pane already shows the new image */
    }
  }

  async function apply(hit: ArtworkHit) {
    const al = selectedAlbum;
    if (!al) {
      err = t("studio.covers.errNoTarget");
      return;
    }
    applying = hit.artwork;
    err = null;
    msg = null;
    try {
      const res = await api.artworkApply(al.folder_key, hit.artwork);
      await afterCoverChange(al.id, al.name, res);
    } catch (e) {
      err = studioErrorText(e);
    } finally {
      applying = null;
    }
  }

  async function upload(file: File) {
    const al = selectedAlbum;
    if (!al) {
      err = t("studio.covers.errNoTarget");
      return;
    }
    if (!file.type.startsWith("image/")) {
      err = t("studio.err.unsupportedImage");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      err = t("studio.err.imageTooLarge");
      return;
    }
    applying = "upload";
    err = null;
    msg = null;
    try {
      const res = await api.artworkUpload(al.folder_key, file);
      await afterCoverChange(al.id, al.name, res);
    } catch (e) {
      err = studioErrorText(e);
    } finally {
      applying = null;
    }
  }

  function linkLabel(hit: ArtworkHit): string {
    try {
      const u = new URL(hit.url || hit.artwork);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return t("studio.covers.open");
    }
  }
</script>

<div class="studio-pane tools-art" role="region" aria-label={t("studio.covers.regionAria")}>
  <StudioAccessNotice what={t("studio.access.coversReadOnly")} />
  <div class="studio-covers-split">
    <div class="studio-panel studio-covers-target">
      <h4 class="studio-panel-title">{t("studio.covers.target")}</h4>
      <div class="studio-covers-target__body">
        <div class="studio-covers-current">
          <CoverArt
            title={selectedAlbum?.name ?? ""}
            seed={selectedAlbum ? `${selectedAlbum.artist_name}/${selectedAlbum.name}` : ""}
            src={currentCoverSrc}
            size="xl"
          />
          <span class="subtle sm studio-covers-current__cap">
            {#if !selectedAlbum}
              {t("studio.covers.currentNone")}
            {:else if currentCoverSrc}
              {t("studio.covers.current")}
            {:else}
              {t("studio.covers.currentMissing")}
            {/if}
          </span>
        </div>
        <div class="studio-covers-target__fields">
          <div class="studio-picker-picks tools-studio-pair-picks tools-cover-save-picks">
            <div>
              <label class="subtle sm block-label" for="cover-artist-sel">{t("studio.covers.artist")}</label>
              <select
                id="cover-artist-sel"
                class="rk-select"
                value={coverArtistId ?? ""}
                onchange={(e) => {
                  const v = e.currentTarget.value;
                  coverArtistId = v ? Number(v) : null;
                  coverAlbumId = null;
                }}
              >
                <option value="">{t("studio.covers.choose")}</option>
                {#each artistsSorted as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
            </div>
            <div>
              <label class="subtle sm block-label" for="cover-album-sel">{t("studio.covers.album")}</label>
              <select
                id="cover-album-sel"
                class="rk-select"
                value={coverAlbumId ?? ""}
                disabled={!coverArtist}
                onchange={(e) => {
                  const v = e.currentTarget.value;
                  coverAlbumId = v ? Number(v) : null;
                  const al = coverAlbums.find((a) => a.id === coverAlbumId);
                  if (al) artQuery = `${al.artist_name} ${al.name}`;
                }}
              >
                {#if !coverArtist}
                  <option value="">{t("studio.covers.needArtist")}</option>
                {:else}
                  <option value="">{t("studio.covers.chooseAlbum")}</option>
                  {#each coverAlbums as al (al.id)}
                    <option value={al.id}>{al.name}</option>
                  {/each}
                {/if}
              </select>
            </div>
          </div>
          {#if selectedAlbum}
            <p class="art-target sm"><code>{selectedAlbum.folder_key}</code></p>
          {/if}
          <FileDrop
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            compact
            label={applying === "upload" ? t("studio.covers.uploading") : t("studio.covers.upload")}
            buttonLabel={t("studio.covers.uploadButton")}
            hint={t("studio.covers.uploadHint")}
            disabled={!selectedAlbum || !canWrite || applying != null}
            onfiles={(files) => {
              const f = files[0];
              if (f) void upload(f);
            }}
          />
        </div>
      </div>
    </div>

    <div class="studio-panel">
      <h4 class="studio-panel-title">{t("studio.covers.search")}</h4>
      <div class="art-fields">
        <label class="art-field">
          <span class="subtle sm block-label">{t("studio.covers.searchLabel")}</span>
          <input
            type="text"
            class="ghost-input"
            bind:value={artQuery}
            placeholder={t("studio.covers.searchPh")}
            disabled={busy}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
        </label>
      </div>
      <div class="studio-inline-actions studio-inline-actions--spaced">
        <button
          type="button"
          class="ghost-btn ghost-btn--sm"
          disabled={!session.current}
          onclick={fillFromPlayback}
        >
          {t("studio.covers.fillFromPlayback")}
        </button>
        <button type="button" class="primary-btn" disabled={busy} onclick={() => void search()}>
          {busy ? t("studio.covers.searching") : t("studio.covers.searchBtn")}
        </button>
      </div>
    </div>
  </div>

  {#if err}
    <p class="subtle sm warnline" role="alert">{err}</p>
  {/if}
  {#if msg}
    <p class="subtle sm studio-covers-msg" role="status">{msg}</p>
  {/if}
  {#if sourceErrors.length}
    <p class="subtle sm warnline" role="note">
      {t("studio.covers.partial", { sources: sourceErrors.join(" · ") })}
    </p>
  {/if}

  {#if results.length}
    <div class="artgrid2">
      {#each results as hit, i (`${hit.artwork}:${i}`)}
        <div class="artcard2">
          <div class="artcard2-img">
            <img src={hit.artwork} alt={hit.name} loading="lazy" />
            {#if hit.source}
              <span class="art-src">{hit.source}</span>
            {/if}
          </div>
          <div class="artcap2">
            <strong>{hit.artist}</strong><br />{hit.name}
          </div>
          <div class="art-actions">
            <a class="extlink" href={hit.url || hit.artwork} target="_blank" rel="noreferrer noopener">
              {linkLabel(hit)}
            </a>
            <button
              type="button"
              class="primary-btn primary-btn--sm"
              disabled={applying != null || !selectedAlbum || !canWrite}
              title={writeTitle ?? (!selectedAlbum ? t("studio.covers.errNoTarget") : undefined)}
              onclick={() => void apply(hit)}
            >
              {applying === hit.artwork ? t("studio.covers.applying") : t("studio.covers.saveCover")}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {:else if searched && !busy && !err}
    <EmptyState variant="inline" title={t("studio.covers.noneFound")} body={t("studio.covers.noneFoundHint")} />
  {:else if !searched}
    <p class="subtle sm studio-covers-hint">{t("studio.covers.searchHint")}</p>
  {/if}
</div>
