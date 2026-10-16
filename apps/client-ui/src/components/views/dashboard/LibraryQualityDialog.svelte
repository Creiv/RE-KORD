<script lang="ts">
  /**
   * Dashboard › "Da sistemare": what the quality alerts count, one tab per
   * issue, each item with the action that fixes it (album page, track edit,
   * Studio › Copertine / Metadati with the album already picked).
   *
   * Light: mounted only while open; the lists are built from the account's
   * catalog (`lib/libraryQuality`, the hub's definitions) and shown a page at a
   * time. A fix made here (or anywhere) goes through `session.applyLibraryChange`
   * and the lists and counters follow at once.
   */
  import { untrack } from "svelte";
  import { Button, CoverArt, EmptyState, Modal, Tabs } from "@rekord/ui";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { coverUrlFor, type Album, type Track } from "../../../lib/api";
  import { fmtNumber, i18n, t, tp } from "../../../lib/i18n.svelte";
  import { QUALITY_ISSUES, qualityLists, type QualityIssue } from "../../../lib/libraryQuality";
  import { session } from "../../../lib/session.svelte";
  import { requestStudioAlbum } from "../../../lib/studio/focus.svelte";

  const PAGE = 60;

  let {
    initialTab = "albums-without-cover",
    onclose,
    onopenalbum,
  }: {
    initialTab?: QualityIssue;
    onclose: () => void;
    onopenalbum: (albumId: number) => void;
  } = $props();

  let tab = $state<QualityIssue>(untrack(() => initialTab));
  let shown = $state(PAGE);

  const lists = $derived(qualityLists(session.allAlbums, session.catalogTracks, i18n.sortLocale));

  const tabs = $derived(
    QUALITY_ISSUES.map((id) => ({
      id,
      label: t(`dashboard.alert.${id}`),
      count: fmtNumber(lists[id].length),
    })),
  );

  const albums = $derived(tab === "tracks-without-meta" ? [] : (lists[tab] as Album[]));
  const tracks = $derived(tab === "tracks-without-meta" ? lists[tab] : ([] as Track[]));
  const total = $derived(tab === "tracks-without-meta" ? tracks.length : albums.length);

  function select(id: string) {
    tab = id as QualityIssue;
    shown = PAGE;
  }

  function openAlbum(a: Album) {
    onclose();
    onopenalbum(a.id);
  }

  function openStudio(pane: "covers" | "meta", a: Album) {
    requestStudioAlbum(pane, a.id);
    session.studioPane = pane;
    session.navigate("studio");
    onclose();
  }

  function trackLine(tr: Track): string {
    return [tr.artist_name, tr.album_name].filter(Boolean).join(" · ");
  }
</script>

<Modal open title={t("quality.title")} eyebrow={t("dashboard.qualityEyebrow")} panelClass="quality-dialog" {onclose}>
  <Tabs items={tabs} active={tab} onselect={select} size="sm" ariaLabel={t("quality.tabsAria")} />
  <p class="quality-dialog__hint">{t(`quality.hint.${tab}`)}</p>

  {#if total === 0}
    <EmptyState variant="inline" title={t("dashboard.qualityOk")} body={t("quality.emptyBody")}>
      {#snippet icon()}<UiIcon name="check" />{/snippet}
    </EmptyState>
  {:else}
    <ul class="quality-list" aria-label={t(`dashboard.alert.${tab}`)}>
      {#if tab === "tracks-without-meta"}
        {#each tracks.slice(0, shown) as tr (tr.id)}
          <li class="quality-item">
            <CoverArt kind="track" size="sm" title={tr.title} src={coverUrlFor(tr, 96)} />
            <span class="quality-item__text">
              <span class="quality-item__title" title={tr.title}>{tr.title}</span>
              <span class="quality-item__sub">{trackLine(tr)}</span>
            </span>
            <span class="quality-item__actions">
              <Button size="sm" variant="secondary" onclick={() => session.openTrackEdit(tr)}>
                <UiIcon name="edit" />
                {t("quality.editTrack")}
              </Button>
            </span>
          </li>
        {/each}
      {:else}
        {#each albums.slice(0, shown) as a (a.id)}
          <li class="quality-item">
            <CoverArt kind="album" size="sm" title={a.name} src={coverUrlFor(a, 96)} />
            <span class="quality-item__text">
              <span class="quality-item__title" title={a.name}>{a.name}</span>
              <span class="quality-item__sub">
                {a.artist_name} · {tp("library.tracksCount", a.track_count)}
              </span>
            </span>
            <span class="quality-item__actions">
              {#if tab === "albums-without-cover"}
                <Button size="sm" variant="secondary" onclick={() => openStudio("covers", a)}>
                  <UiIcon name="image" />
                  {t("quality.fixCover")}
                </Button>
              {:else if tab === "albums-without-meta"}
                <Button size="sm" variant="secondary" onclick={() => openStudio("meta", a)}>
                  <UiIcon name="build" />
                  {t("quality.fixMeta")}
                </Button>
              {/if}
              <Button
                size="sm"
                variant="ghost"
                title={t("quality.openAlbum")}
                aria-label={t("quality.openAlbumAria", { name: a.name })}
                onclick={() => openAlbum(a)}
              >
                <UiIcon name="album" />
                <span class="quality-item__label">{t("quality.openAlbum")}</span>
              </Button>
            </span>
          </li>
        {/each}
      {/if}
    </ul>
    {#if total > shown}
      <div class="quality-more">
        <Button variant="ghost" size="sm" onclick={() => (shown += PAGE)}>
          {t("quality.showMore", { n: fmtNumber(Math.min(PAGE, total - shown)), left: fmtNumber(total - shown) })}
        </Button>
      </div>
    {/if}
  {/if}
</Modal>

<style>
  :global(.rk-modal.quality-dialog) {
    width: min(40rem, 100%);
  }

  .quality-dialog__hint {
    margin: 0.6rem 0 0.5rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }

  .quality-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }

  .quality-item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.7rem;
    padding: 0.4rem 0.5rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
  }

  .quality-item__text {
    min-width: 0;
    display: grid;
    gap: 0.1rem;
  }

  .quality-item__title,
  .quality-item__sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quality-item__title {
    font-weight: 600;
    font-size: var(--rk-fs-sm);
    color: var(--rk-ink);
  }

  .quality-item__sub {
    font-size: var(--rk-fs-xs, 0.78rem);
    color: var(--rk-muted);
  }

  .quality-item__actions {
    display: inline-flex;
    gap: 0.3rem;
    flex-shrink: 0;
  }

  .quality-item__actions :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  .quality-more {
    display: flex;
    justify-content: center;
    padding-top: 0.5rem;
  }

  /* Phone: the album button keeps only its icon. */
  @media (max-width: 559.98px) {
    .quality-item__label {
      display: none;
    }

    .quality-item {
      gap: 0.5rem;
    }
  }
</style>
