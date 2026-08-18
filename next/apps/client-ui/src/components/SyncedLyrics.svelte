<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import { player } from "../lib/player";
  import { currentLrcLineIndex, parseLrcLyrics } from "../lib/visualizer/lrc";

  let {
    lyrics = "",
    currentTime = 0,
    autoScroll = true,
  }: {
    lyrics?: string;
    currentTime?: number;
    /** Off while the panel is hidden, so scrolling does not fight the user. */
    autoScroll?: boolean;
  } = $props();

  /** Auto-scroll pauses this long after the user scrolls by hand. */
  const RESUME_DELAY_MS = 3200;
  const SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ]);

  let scrollEl: HTMLDivElement | null = $state(null);
  let lineEls = $state<(HTMLButtonElement | null)[]>([]);
  let pausedByUser = $state(false);
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  const lines = $derived(parseLrcLyrics(lyrics));
  const currentIndex = $derived(currentLrcLineIndex(lines, currentTime));
  const plainLines = $derived(
    lines.length
      ? []
      : lyrics
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
  );

  function pauseAutoScroll() {
    pausedByUser = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      pausedByUser = false;
    }, RESUME_DELAY_MS);
  }

  function reducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
  }

  function seekTo(atSec: number) {
    pausedByUser = false;
    if (resumeTimer) clearTimeout(resumeTimer);
    player.seek(atSec);
  }

  // Pausing keys off user intent, not scroll events, which smooth auto-scroll
  // would otherwise trigger itself.
  $effect(() => {
    const wrap = scrollEl;
    if (!wrap) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) pauseAutoScroll();
    };
    wrap.addEventListener("wheel", pauseAutoScroll, { passive: true });
    wrap.addEventListener("touchmove", pauseAutoScroll, { passive: true });
    wrap.addEventListener("keydown", onKeyDown);
    return () => {
      wrap.removeEventListener("wheel", pauseAutoScroll);
      wrap.removeEventListener("touchmove", pauseAutoScroll);
      wrap.removeEventListener("keydown", onKeyDown);
    };
  });

  // Keeps the active line centred.
  $effect(() => {
    const index = currentIndex;
    const wrap = scrollEl;
    if (!autoScroll || !wrap || !lines.length || pausedByUser) return;
    if (index < 0) {
      wrap.scrollTop = 0;
      return;
    }
    const line = lineEls[index];
    if (!line) return;
    const target =
      line.offsetTop + line.offsetHeight / 2 - wrap.clientHeight / 2;
    const max = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.scrollTo({
      top: Math.max(0, Math.min(target, max)),
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  });

  $effect(() => {
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
    };
  });
</script>

{#if lines.length}
  <div class="synced-lyrics" bind:this={scrollEl}>
    {#each lines as line, index (`${index}-${line.atSec}`)}
      <button
        type="button"
        class="synced-lyrics__line"
        class:is-current={index === currentIndex}
        class:is-past={index < currentIndex}
        bind:this={lineEls[index]}
        title={t("listen.lyricsSeekTitle")}
        onclick={() => seekTo(line.atSec)}
      >
        {line.text || "…"}
      </button>
    {/each}
  </div>
{:else if plainLines.length}
  <div class="synced-lyrics synced-lyrics--plain">
    {#each plainLines as line, index (index)}
      <p class="synced-lyrics__line synced-lyrics__line--plain">{line}</p>
    {/each}
  </div>
{/if}
