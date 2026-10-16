<script lang="ts">
  /**
   * Karaoke backdrop: the sung line's strongest words, huge and
   * faint behind the karaoke column, drifting for as long as the line lasts.
   * One or two text elements on screen; only `transform` / `opacity` move.
   */
  import { fade } from "svelte/transition";
  import { fitSize, planLine, type WordsPlan } from "../../lib/visualizer/karaokeWords";

  let {
    lines,
    active,
    starts = null,
    fallbackSpan = 4,
    currentTime = 0,
    playing = false,
    title = "",
  }: {
    lines: string[];
    /** Index of the sung line (-1: before the first). */
    active: number;
    /** Start time (s) of each line when synced; null for plain lyrics. */
    starts?: number[] | null;
    /** Seconds per line when not synced. */
    fallbackSpan?: number;
    currentTime?: number;
    playing?: boolean;
    title?: string;
  } = $props();

  const plans = $derived(lines.map((l) => planLine(l)));
  /** Before the first line: the title sets the stage. */
  const introPlan = $derived<WordsPlan>({
    words: title ? [title.toLocaleUpperCase()] : [],
    layout: "giant",
    a: 0.5,
    b: 0.5,
  });
  const plan = $derived(active >= 0 ? plans[active] : introPlan);

  /** How long the current line lasts (s): drives the drift. */
  function spanOf(i: number): number {
    if (!starts) return fallbackSpan;
    const from = i >= 0 ? (starts[i] ?? 0) : 0;
    const to = starts[i + 1] ?? from + 6;
    return Math.min(10, Math.max(2.5, to - from));
  }

  /** Drift timing, set once when the line appears (seek / late tick land mid-drift). */
  function startDrift(node: HTMLElement, i: number) {
    const span = spanOf(i);
    const from = starts ? (i >= 0 ? (starts[i] ?? 0) : 0) : null;
    const elapsed = from == null ? 0 : Math.min(span, Math.max(0, currentTime - from));
    node.style.animationDuration = `${span + 1.2}s`;
    node.style.animationDelay = `${-elapsed}s`;
  }
</script>

<div class="kw" class:is-paused={!playing} aria-hidden="true">
  {#key active}
    {#if plan && plan.words.length}
      {@const w0 = plan.words[0]!}
      <div
        class="kw-comp kw-{plan.layout}"
        style:--a={plan.a}
        style:--b={plan.b}
        in:fade={{ duration: 450 }}
        out:fade={{ duration: 650 }}
      >
        {#if plan.layout === "giant"}
          <span class="kw-word kw-outline kw-drift-x" style:font-size={fitSize(w0, 1.08, 46)} use:startDrift={active}
            >{w0}</span
          >
        {:else if plan.layout === "tilt"}
          <span class="kw-word kw-tint kw-drift-zoom" style:font-size={fitSize(w0, 0.95, 40)} use:startDrift={active}
            >{w0}</span
          >
        {:else if plan.layout === "edge"}
          <!-- Rotated: its own x axis runs up the screen, so the x drift slides it vertically. -->
          <span
            class="kw-word kw-outline kw-drift-x"
            style:left={plan.b < 0.5 ? "8vw" : "92vw"}
            style:font-size={fitSize(w0, 0.95, 24)}
            use:startDrift={active}>{w0}</span
          >
        {:else if plan.layout === "echo"}
          <div class="kw-echo kw-drift-x" use:startDrift={active}>
            {#each [0, 1, 2] as n}
              <span class="kw-word kw-outline" style:font-size={fitSize(w0, 0.8, 19)} style:--n={n}>{w0}</span>
            {/each}
          </div>
        {:else if plan.layout === "stack"}
          <div class="kw-stack kw-drift-y" use:startDrift={active}>
            {#each plan.words as w, n}
              <span
                class="kw-word"
                class:kw-fill={n === 0}
                class:kw-tint={n === 1}
                style:font-size={fitSize(w, 0.86, 24)}>{w}</span
              >
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/key}
</div>

<style>
  .kw {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .kw-comp {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .kw-word {
    display: block;
    font-weight: 900;
    line-height: 0.86;
    letter-spacing: -0.045em;
    white-space: nowrap;
    color: transparent;
    will-change: transform;
  }

  /* Three looks, all quiet enough for the sung line on top. */
  .kw-outline {
    -webkit-text-stroke: 2px color-mix(in srgb, var(--rk-ink) 14%, transparent);
  }
  .kw-fill {
    color: color-mix(in srgb, var(--rk-ink) 6%, transparent);
  }
  .kw-tint {
    color: color-mix(in srgb, var(--rk-accent) 9%, transparent);
    -webkit-text-stroke: 1.5px color-mix(in srgb, var(--rk-accent) 20%, transparent);
  }

  /* giant: one word across the whole stage, a bit above the middle. */
  .kw-giant {
    align-items: center;
    padding-bottom: 8vh;
  }

  /* tilt: a slanted word, off centre. */
  .kw-tilt .kw-word {
    rotate: calc(-11deg + var(--a) * 22deg);
    translate: calc((var(--b) - 0.5) * 18vw) calc((var(--a) - 0.5) * 22vh);
  }

  /* edge: a vertical word along one side. */
  .kw-edge {
    justify-content: flex-start;
  }
  .kw-edge .kw-word {
    position: absolute;
    top: 50%;
    translate: -50% -50%;
    rotate: -90deg;
  }

  /* echo: the word three times, fading, shifted like a delay. */
  .kw-echo {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.6vh;
  }
  .kw-echo .kw-word {
    opacity: calc(1 - var(--n) * 0.32);
    translate: calc(var(--n) * 6vw) 0;
  }

  /* stack: two words on top of each other, left aligned. */
  .kw-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-right: calc(var(--a) * 14vw);
  }

  /* Drifts: one slow move over the line's span (duration set per line). */
  .kw-drift-x,
  .kw-drift-y,
  .kw-drift-zoom {
    animation-timing-function: linear;
    animation-fill-mode: both;
  }
  .kw-drift-x {
    animation-name: kw-drift-x;
  }
  .kw-drift-y {
    animation-name: kw-drift-y;
  }
  .kw-drift-zoom {
    animation-name: kw-drift-zoom;
  }
  @keyframes kw-drift-x {
    from {
      transform: translate3d(4vw, 0, 0);
    }
    to {
      transform: translate3d(-4vw, 0, 0);
    }
  }
  @keyframes kw-drift-y {
    from {
      transform: translate3d(0, 3vh, 0);
    }
    to {
      transform: translate3d(0, -3vh, 0);
    }
  }
  @keyframes kw-drift-zoom {
    from {
      transform: scale(0.96);
    }
    to {
      transform: scale(1.06);
    }
  }

  .kw.is-paused * {
    animation-play-state: paused;
  }

  @media (prefers-reduced-motion: reduce) {
    .kw * {
      animation: none !important;
    }
  }
</style>
