<script lang="ts">
  import UiIcon from "./icons/UiIcon.svelte";
  import TrackMoodGlyph from "./TrackMoodGlyph.svelte";
  import type { TrackMoodId } from "../lib/trackMoods";
  import { TRACK_MOOD_COLORS, TRACK_MOOD_LABELS } from "../lib/trackMoods";

  let {
    /** Track/inline: gap meta + mood. Card/hero: chip di stato album/artista. */
    variant = "foot" as "foot" | "hero" | "inline",
    /** Solo track/genre: mostra mood. */
    moods = [] as TrackMoodId[],
    missingMeta = false,
    /** Conteggio album senza meta (artista) oppure flag album (se >0 → A on). */
    albumsMissingMetaCount = 0,
    tracksMissingMetaCount = 0,
    favoriteCount = 0,
    /** Album intero escluso (chip R). */
    albumExcluded = false,
    /** N album esclusi (artista). */
    albumsExcludedCount = 0,
    /** Brani esclusi (singoli o per album). */
    tracksExcludedCount = 0,
    /** Card album loose: solo chip nota. */
    loose = false,
  }: {
    variant?: "foot" | "hero" | "inline";
    moods?: TrackMoodId[];
    missingMeta?: boolean;
    albumsMissingMetaCount?: number;
    tracksMissingMetaCount?: number;
    favoriteCount?: number;
    albumExcluded?: boolean;
    albumsExcludedCount?: number;
    tracksExcludedCount?: number;
    loose?: boolean;
  } = $props();

  const isCard = $derived(variant === "foot" || variant === "hero");
  const aOn = $derived(
    albumsMissingMetaCount > 0 || (albumsMissingMetaCount === 0 && missingMeta),
  );
  const aCount = $derived(albumsMissingMetaCount > 0 ? albumsMissingMetaCount : 0);
  const noteOn = $derived(tracksMissingMetaCount > 0);
  const favOn = $derived(favoriteCount > 0);
  const rOn = $derived(albumExcluded || albumsExcludedCount > 0);
  const rCount = $derived(albumsExcludedCount > 0 ? albumsExcludedCount : 0);
  const exOn = $derived(tracksExcludedCount > 0);
</script>

<div
  class="lib-meta-badges"
  class:lib-meta-badges--tight={variant === "foot"}
  class:lib-meta-badges--hero={variant === "hero"}
  class:lib-meta-badges--inline={variant === "inline"}
  class:lib-badge-cluster--card-foot={variant === "foot"}
>
  {#if isCard}
    {#if !loose}
      <span
        class="lib-meta-chip"
        class:lib-meta-chip--on={aOn}
        title={aOn ? "Metadati album mancanti" : "Metadati album nel database"}
      >
        A{aCount > 0 ? aCount : ""}
      </span>
    {/if}
    <span
      class="lib-meta-chip lib-meta-chip--ico"
      class:lib-meta-chip--on={noteOn}
      title={noteOn
        ? `Brani senza data o genere: ${tracksMissingMetaCount}`
        : "Tutti i brani hanno data o genere nei metadati"}
    >
      <UiIcon name="music" class="lib-meta-chip__ico" />
      {#if noteOn}<span class="lbl">{tracksMissingMetaCount}</span>{/if}
    </span>
    <span
      class="lib-meta-chip lib-meta-chip--fav lib-meta-chip--ico"
      class:lib-meta-chip--on={favOn}
      title={favOn ? `Preferiti: ${favoriteCount}` : "Nessun brano preferito"}
    >
      <UiIcon name="favorite" class="lib-meta-chip__ico" />
      {#if favOn}<span class="lbl">{favoriteCount}</span>{/if}
    </span>
    <span
      class="lib-meta-chip lib-meta-chip--exclude"
      class:lib-meta-chip--on={rOn}
      title={rOn ? "Album escluso dallo shuffle" : "Album non bloccato dallo shuffle"}
    >
      R{rCount > 0 ? rCount : ""}
    </span>
    <span
      class="lib-meta-chip lib-meta-chip--exclude lib-meta-chip--ico"
      class:lib-meta-chip--on={exOn}
      title={exOn
        ? `Brani esclusi: ${tracksExcludedCount}`
        : "Nessun brano bloccato singolarmente dallo shuffle"}
    >
      <UiIcon name="exclude" class="lib-meta-chip__ico" />
      {#if exOn}<span class="lbl">{tracksExcludedCount}</span>{/if}
    </span>
  {:else}
    <span
      class="lib-meta-chip lib-meta-chip--ico"
      class:lib-meta-chip--on={missingMeta}
      title={missingMeta ? "Metadati incompleti" : "Metadati ok"}
    >
      <UiIcon name="music" class="lib-meta-chip__ico" />
    </span>
    <span class="track-meta-moods-cluster">
      {#if moods.length === 0}
        <span class="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-off" title="Nessun mood">
          <TrackMoodGlyph mood={null} class="track-meta-mood-chip__glyph" />
        </span>
      {:else}
        {#each moods.slice(0, 3) as m (m)}
          <span
            class="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-tag"
            title={TRACK_MOOD_LABELS[m]}
            style="--mood-c:{TRACK_MOOD_COLORS[m]}"
          >
            <TrackMoodGlyph mood={m} class="track-meta-mood-chip__glyph" />
          </span>
        {/each}
      {/if}
    </span>
  {/if}
</div>

<style>
  .lib-meta-badges {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.28rem;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    max-width: 100%;
    /* Arrivati in fondo ai badge il gesto si ferma qui: sul telefono uno scorrimento
       orizzontale che passa alla pagina fa scattare il «torna indietro». */
    overscroll-behavior-x: contain;
    /* Orizzontale a noi, verticale al browser: la riga non blocca lo scorrimento. */
    touch-action: pan-x pan-y;
  }

  .lib-meta-badges--tight {
    margin-top: 0.1rem;
    justify-content: flex-start;
  }

  .lib-badge-cluster--card-foot {
    margin-top: 0.35rem;
    width: 100%;
    padding-top: 0.4rem;
    justify-content: flex-start;
    align-content: flex-end;
    flex-wrap: nowrap;
    gap: 0.28rem;
  }

  .lib-meta-badges--hero {
    margin: 0;
  }

  .lib-meta-badges--inline {
    margin-top: 0;
    display: inline-flex;
  }

  .lib-meta-badges::-webkit-scrollbar {
    display: none;
  }

  .lib-meta-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.12rem;
    font-size: var(--rk-fs-3xs);
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: var(--rk-lh-tight);
    padding: 0.2rem 0.38rem;
    border-radius: var(--rk-radius);
    letter-spacing: 0.02em;
    background: color-mix(in srgb, var(--rk-muted) 3%, var(--rk-surface-2) 97%);
    color: color-mix(in srgb, var(--rk-muted) 55%, var(--rk-surface-2) 45%);
    border: 1px solid color-mix(in srgb, var(--rk-line) 35%, transparent 65%);
    opacity: 0.28;
    flex-shrink: 0;
  }

  .lib-meta-chip--ico {
    gap: 0.12rem;
  }

  .lib-meta-chip--on {
    opacity: 1;
    background: color-mix(in srgb, #eab308 14%, var(--rk-surface-2) 86%);
    color: var(--rk-ink);
    border: 1px solid color-mix(in srgb, #eab308 32%, var(--rk-line) 68%);
  }

  .lib-meta-chip--fav {
    opacity: 0.28;
  }

  .lib-meta-chip--fav.lib-meta-chip--on {
    opacity: 1;
    background: color-mix(in srgb, var(--rk-danger) 14%, var(--rk-surface-2) 86%);
    color: color-mix(in srgb, var(--rk-danger) 92%, var(--rk-ink) 8%);
    border: 1px solid color-mix(in srgb, var(--rk-danger) 34%, var(--rk-line) 66%);
  }

  .lib-meta-chip--exclude {
    background: color-mix(in srgb, var(--rk-muted) 2%, var(--rk-surface-2) 98%);
    border-color: color-mix(in srgb, var(--rk-line) 30%, transparent 70%);
    color: color-mix(in srgb, var(--rk-muted) 50%, var(--rk-surface-2) 50%);
    opacity: 0.28;
  }

  .lib-meta-chip--exclude.lib-meta-chip--on {
    background: color-mix(in srgb, var(--rk-accent-2) 12%, var(--rk-surface-2) 88%);
    border-color: color-mix(in srgb, var(--rk-accent-2) 40%, var(--rk-line) 60%);
    color: var(--rk-muted-strong);
    opacity: 1;
  }

  .lib-meta-chip--mood-off {
    opacity: 0.12;
    filter: grayscale(0.45);
  }

  .lib-meta-chip--mood-tag {
    opacity: 1;
    color: color-mix(in srgb, var(--mood-c) 88%, var(--rk-ink));
    background: color-mix(in srgb, var(--mood-c) 18%, var(--rk-surface-2) 82%);
    border: 1px solid color-mix(in srgb, var(--mood-c) 42%, var(--rk-line) 58%);
  }

  .track-meta-moods-cluster {
    display: inline-flex;
    align-items: center;
    gap: 0.18rem;
    flex-wrap: nowrap;
  }

  /* 0.72rem come old tracklist.css — batte default UiIcon (1.25) / mood-g (0.95) */
  .lib-meta-chip.lib-meta-chip--ico :global(.ui-ic),
  .lib-meta-chip.lib-meta-chip--ico :global(.lib-meta-chip__ico) {
    width: 0.72rem;
    height: 0.72rem;
    flex-shrink: 0;
  }

  .lib-meta-chip.lib-meta-chip--ico :global(.track-meta-mood-chip__glyph),
  .lib-meta-chip.lib-meta-chip--ico :global(.mood-g) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
    width: 0.72rem;
    height: 0.72rem;
  }

  .lib-meta-chip.lib-meta-chip--ico :global(.track-meta-mood-chip__glyph svg),
  .lib-meta-chip.lib-meta-chip--ico :global(.mood-g svg) {
    width: 0.72rem;
    height: 0.72rem;
    display: block;
  }

  .lbl {
    font-family: var(--rk-mono);
    letter-spacing: 0.02em;
  }
</style>
