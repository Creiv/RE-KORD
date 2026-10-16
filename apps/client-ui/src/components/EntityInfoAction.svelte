<script lang="ts">
  /**
   * "Curiosità" button + dialog for an artist or an album page.
   *
   * States: while the bundle loads the button is shown pending (no layout
   * jump); a failed load keeps the button and the dialog explains + retries;
   * a bundle with entries only in another language opens on an empty state
   * that offers them. Nothing saved at all → no button.
   * Loose-track folders are not albums: no request, no button.
   */
  import { Button, CoverArt, Modal } from "@rekord/ui";
  import { api, type EntityInfoBundle } from "../lib/api";
  import { mediaUrl } from "../lib/config";
  import { i18n, t, tp } from "../lib/i18n.svelte";
  import UiIcon from "./icons/UiIcon.svelte";

  let {
    artistDir,
    albumDir = null,
    title,
    lang,
    loose = false,
  }: {
    /** Artist folder (= folder name in the library). */
    artistDir: string;
    /** Album folder; absent = artist info. */
    albumDir?: string | null;
    title: string;
    /** UI language: default = app locale. Shows only the matching entries. */
    lang?: string;
    /** Album made of loose tracks (no album folder): never asks the hub. */
    loose?: boolean;
  } = $props();

  const EMPTY: EntityInfoBundle = { items: [], image: null };
  const LOOSE_DIR = "__loose__";

  let bundle = $state<EntityInfoBundle>(EMPTY);
  let artistBundle = $state<EntityInfoBundle>(EMPTY);
  let open = $state(false);
  let loading = $state(false);
  let loadError = $state(false);
  /** Show entries in other languages after the user asked for them. */
  let showAllLangs = $state(false);
  let reloadTick = $state(0);

  const activeLang = $derived(lang ?? i18n.locale);
  const isLoose = $derived(
    loose || (albumDir != null && (albumDir === LOOSE_DIR || albumDir.endsWith(`/${LOOSE_DIR}`))),
  );

  const items = $derived(
    showAllLangs ? bundle.items : bundle.items.filter((it) => it.lang === activeLang),
  );
  const otherLangCount = $derived(bundle.items.length - bundle.items.filter((it) => it.lang === activeLang).length);
  const visible = $derived(!isLoose && Boolean(artistDir) && (loading || loadError || bundle.items.length > 0));

  const itemsLede = $derived(
    loading || loadError || items.length === 0
      ? ""
      : tp("entityInfo.itemsCount", items.length),
  );

  function artistImageUrl(dir: string, src: EntityInfoBundle): string | null {
    if (!src.image) return null;
    const base = mediaUrl(`${dir}/${src.image}`);
    const v = src.items[0]?.savedAt ? encodeURIComponent(src.items[0].savedAt) : "";
    if (!v) return base;
    return base.includes("?") ? `${base}&v=${v}` : `${base}?v=${v}`;
  }

  const photo = $derived(artistImageUrl(artistDir, albumDir ? artistBundle : bundle));

  $effect(() => {
    const dir = artistDir;
    const album = albumDir ?? null;
    void reloadTick;
    showAllLangs = false;
    if (!dir || isLoose) {
      bundle = EMPTY;
      artistBundle = EMPTY;
      open = false;
      loading = false;
      loadError = false;
      return;
    }
    let active = true;
    bundle = EMPTY;
    artistBundle = EMPTY;
    loading = true;
    loadError = false;
    void api
      .entityInfo(dir, album)
      .then((next) => {
        if (!active) return;
        bundle = next ?? EMPTY;
        loading = false;
      })
      .catch(() => {
        if (!active) return;
        bundle = EMPTY;
        loading = false;
        loadError = true;
      });
    if (album) {
      void api
        .entityInfo(dir)
        .then((next) => {
          if (active) artistBundle = next ?? EMPTY;
        })
        .catch(() => {
          if (active) artistBundle = EMPTY;
        });
    }
    return () => {
      active = false;
    };
  });
</script>

{#if visible}
  <Button
    variant="ghost"
    class="entity-info-btn"
    disabled={loading}
    aria-busy={loading || undefined}
    title={loading ? t("entityInfo.loading") : t("entityInfo.buttonTitle")}
    aria-label={loading ? t("entityInfo.loading") : t("entityInfo.buttonTitle")}
    onclick={() => (open = true)}
  >
    <UiIcon name="sparkle" class="entity-info-btn__ic" />
    <span class="entity-info-btn__label">{t("entityInfo.button")}</span>
  </Button>

  <Modal
    {open}
    panelClass="entity-info-modal"
    eyebrow={albumDir ? t("entityInfo.albumEyebrow") : t("entityInfo.artistEyebrow")}
    {title}
    lede={itemsLede}
    onclose={() => (open = false)}
  >
    {#snippet lead()}
      {#if photo}
        <CoverArt kind="artist" class="entity-info-dialog__photo" {title} src={photo} />
      {:else}
        <span class="entity-info-dialog__photo-fallback" aria-hidden="true">
          <UiIcon name="sparkle" class="entity-info-dialog__photo-fallback-ic" />
        </span>
      {/if}
    {/snippet}

    <div class="entity-info-dialog__body rk-scroll">
      {#if loading}
        <p class="entity-info-dialog__status" role="status">{t("entityInfo.loading")}</p>
      {:else if loadError}
        <div class="entity-info-dialog__state" role="alert">
          <p class="entity-info-dialog__status entity-info-dialog__status--err">{t("entityInfo.loadError")}</p>
          <Button variant="ghost" onclick={() => (reloadTick += 1)}>{t("entityInfo.retry")}</Button>
        </div>
      {:else if items.length === 0}
        <div class="entity-info-dialog__state">
          <p class="entity-info-dialog__status">{t("entityInfo.empty")}</p>
          {#if otherLangCount > 0}
            <Button variant="ghost" onclick={() => (showAllLangs = true)}>
              {t("entityInfo.showOtherLangs", { n: otherLangCount })}
            </Button>
          {/if}
        </div>
      {:else}
        {#each items as item (item.id)}
          <article class="entity-info-dialog__item" lang={item.lang || undefined}>
            {#if item.title}
              <h3 class="entity-info-dialog__item-title">{item.title}</h3>
            {/if}
            {#each item.text.split(/\n+/).filter(Boolean) as paragraph, i (i)}
              <p>{paragraph}</p>
            {/each}
          </article>
        {/each}
      {/if}
    </div>

    {#snippet footer()}
      <span class="rk-modal-foot-spacer" aria-hidden="true"></span>
      <Button variant="ghost" onclick={() => (open = false)}>{t("entityInfo.close")}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  :global(.entity-info-btn) {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  :global(.entity-info-btn__ic),
  :global(.entity-info-btn svg) {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  :global(.rk-modal.entity-info-modal) {
    width: min(35rem, 100%);
  }

  /* Entry count: UI typography, not the generic lede's mono path */
  :global(.rk-modal.entity-info-modal .lede) {
    font-family: inherit;
    word-break: normal;
    letter-spacing: 0.01em;
  }

  :global(.rk-cover.entity-info-dialog__photo) {
    width: 72px;
    height: 72px;
    --cover-initials: 1.5rem;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--rk-line) 70%, transparent);
    box-shadow: var(--rk-shadow-2);
  }

  .entity-info-dialog__photo-fallback {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: var(--rk-accent);
    background:
      radial-gradient(
        circle at 30% 25%,
        color-mix(in srgb, var(--rk-accent) 22%, transparent),
        transparent 55%
      ),
      color-mix(in srgb, var(--rk-surface-3) 80%, transparent);
    border: 1px solid color-mix(in srgb, var(--rk-line) 70%, transparent);
  }

  :global(.entity-info-dialog__photo-fallback-ic),
  .entity-info-dialog__photo-fallback :global(svg) {
    width: 1.35rem;
    height: 1.35rem;
  }

  .entity-info-dialog__body {
    display: grid;
    gap: 0.65rem;
      max-height: min(52vh, 460px);
      overflow-y: auto;
      overscroll-behavior: contain;
    padding-right: 0.15rem;
  }

  .entity-info-dialog__status {
    margin: 0;
    padding: 1.1rem 0.85rem;
    text-align: center;
    font-size: var(--rk-fs-md);
    line-height: var(--rk-lh);
    color: var(--rk-muted);
  }

  .entity-info-dialog__state {
    display: grid;
    justify-items: center;
    gap: 0.25rem;
    padding-bottom: 0.5rem;
  }

  .entity-info-dialog__status--err {
    color: color-mix(in srgb, var(--rk-danger, #e85d5d) 85%, var(--rk-ink));
  }

  .entity-info-dialog__item {
    display: grid;
    gap: 0.5rem;
    padding: 0.8rem 0.85rem;
    border-radius: var(--rk-radius-md, 10px);
    background: color-mix(in srgb, var(--rk-surface-3) 58%, transparent);
    border: 1px solid color-mix(in srgb, var(--rk-line) 55%, transparent);
  }

  .entity-info-dialog__item p {
    margin: 0;
    font-size: var(--rk-fs-md);
    line-height: 1.65;
    color: var(--rk-ink);
  }

  .entity-info-dialog__item-title {
    margin: 0;
    font-size: var(--rk-fs-sm);
    font-weight: 700;
    color: var(--rk-accent);
  }
</style>
