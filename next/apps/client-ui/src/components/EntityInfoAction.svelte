<script lang="ts">
  import { Button, Modal } from "@rekord/ui";
  import { api, type EntityInfoBundle } from "../lib/api";
  import { mediaUrl } from "../lib/config";
  import UiIcon from "./icons/UiIcon.svelte";

  let {
    artistDir,
    albumDir = null,
    title,
    lang = "it",
  }: {
    /** Cartella artista (= nome cartella in libreria). */
    artistDir: string;
    /** Cartella album; assente = info dell'artista. */
    albumDir?: string | null;
    title: string;
    /** Lingua UI: mostra solo le voci corrispondenti. */
    lang?: string;
  } = $props();

  const EMPTY: EntityInfoBundle = { items: [], image: null };

  let bundle = $state<EntityInfoBundle>(EMPTY);
  let artistBundle = $state<EntityInfoBundle>(EMPTY);
  let open = $state(false);

  const items = $derived(
    bundle.items.filter((it) => it.lang === lang),
  );

  function artistImageUrl(dir: string, src: EntityInfoBundle): string | null {
    if (!src.image) return null;
    const base = mediaUrl(`${dir}/${src.image}`);
    const v = src.items[0]?.savedAt ? encodeURIComponent(src.items[0].savedAt) : "";
    if (!v) return base;
    return base.includes("?") ? `${base}&v=${v}` : `${base}?v=${v}`;
  }

  const photo = $derived(
    artistImageUrl(artistDir, albumDir ? artistBundle : bundle),
  );

  $effect(() => {
    const dir = artistDir;
    const album = albumDir ?? null;
    if (!dir) {
      bundle = EMPTY;
      artistBundle = EMPTY;
      open = false;
      return;
    }
    let active = true;
    bundle = EMPTY;
    artistBundle = EMPTY;
    open = false;
    void api
      .entityInfo(dir, album)
      .then((next) => {
        if (active) bundle = next;
      })
      .catch(() => {
        if (active) bundle = EMPTY;
      });
    if (album) {
      void api
        .entityInfo(dir)
        .then((next) => {
          if (active) artistBundle = next;
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

{#if items.length}
  <Button
    variant="ghost"
    class="entity-info-btn"
    title="Leggi info e curiosità"
    aria-label="Leggi info e curiosità"
    onclick={() => (open = true)}
  >
    <UiIcon name="sparkle" class="entity-info-btn__ic" />
    <span class="entity-info-btn__label">Curiosità</span>
  </Button>

  <Modal
    {open}
    eyebrow={albumDir ? "Curiosità sull'album" : "Curiosità sull'artista"}
    {title}
    onclose={() => (open = false)}
  >
    {#if photo}
      <img class="entity-info-dialog__photo" src={photo} alt="" aria-hidden="true" />
    {/if}
    <div class="entity-info-dialog__body rk-scroll">
      {#each items as item (item.id)}
        <article class="entity-info-dialog__item">
          {#if item.title}
            <h3 class="entity-info-dialog__item-title">{item.title}</h3>
          {/if}
          {#each item.text.split(/\n+/).filter(Boolean) as paragraph, i (i)}
            <p>{paragraph}</p>
          {/each}
        </article>
      {/each}
    </div>
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

  .entity-info-dialog__photo {
    width: 76px;
    height: 76px;
    object-fit: cover;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 4px 18px color-mix(in srgb, var(--rk-bg) 55%, transparent);
    margin-bottom: 0.25rem;
  }

  .entity-info-dialog__body {
    display: grid;
    gap: 0.6rem;
    max-height: min(48vh, 420px);
    overflow-y: auto;
    line-height: 1.55;
  }

  .entity-info-dialog__body p {
    margin: 0;
  }

  .entity-info-dialog__item {
    display: grid;
    gap: 0.45rem;
    padding: 0.65rem 0;
  }

  .entity-info-dialog__item + .entity-info-dialog__item {
    border-top: 1px solid color-mix(in srgb, var(--rk-line) 60%, transparent);
  }

  .entity-info-dialog__item-title {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--rk-accent);
  }
</style>
