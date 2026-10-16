<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { t } from "../../lib/i18n.svelte";
  import { player } from "../../lib/player";
  import { session } from "../../lib/session.svelte";
  import {
    loadUserPrefs,
    patchUserPrefs,
    subscribeUserPrefs,
    type VisualizerMode,
  } from "../../lib/userPrefs";
  import { currentLrcLineIndex, parseLrcLyrics } from "../../lib/visualizer/lrc";
  import UiIcon from "../icons/UiIcon.svelte";
  import KaraokeWords from "./KaraokeWords.svelte";
  import {
    AdaptiveQuality,
    scaledDpr,
  } from "../../lib/visualizer/adaptiveQuality";
  import {
    canvasDprCap,
    discowallLoopCadence,
    vizEngineDprCap,
    vizLoopCadence,
  } from "../../lib/visualizer/renderQuality";
  import {
    VizCanvasEngine,
    type VizMode,
  } from "../../lib/visualizer/vizCanvasEngine";

  let {
    playing = false,
    mode,
    lyrics = "",
    currentTime = 0,
  }: {
    playing?: boolean;
    /** If omitted, follows Settings → Player visualizer prefs. */
    mode?: VisualizerMode;
    lyrics?: string;
    currentTime?: number;
  } = $props();

  let wrapEl: HTMLDivElement | null = $state(null);
  let canvas: HTMLCanvasElement | null = $state(null);
  let expanded = $state(false);
  let prefsMode = $state<VisualizerMode>(loadUserPrefs().visualizerMode);
  let backdropOn = $state(loadUserPrefs().karaokeBackdrop);

  const engine = new VizCanvasEngine();
  /**
   * DiscoWall is a per-pixel wall: if its frames run over budget the expanded
   * wall drops resolution a step, then the frame rate (level 2).
   */
  const DISCO_BUDGET_MS = 12;
  const DISCO_DPR_STEPS = [1, 0.84, 0.84];
  const DISCO_INTERVAL_STEPS = [1, 1, 1.4];
  const discoQuality = new AdaptiveQuality({ levels: 3, budgetMs: DISCO_BUDGET_MS });
  /**
   * The player routes audio through Web Audio only while someone holds its
   * analyser (costly on some engines): held while a spectrum is drawn on
   * screen for a playing song. Until the graph is up `getAnalyser()` is null
   * and the engine draws its idle state.
   */
  const analyserLease = player.analyserLease();

  let raf = 0;
  let timerId = 0;
  let lastDraw = 0;
  /** Size + mode + expansion + theme of the last painted frame (a static frame stays valid while equal). */
  let lastDrawKey = "";
  function drawKey(): string {
    const c = canvas;
    return `${c?.width ?? 0}x${c?.height ?? 0}|${modeRef}|${expandedRef ? 1 : 0}|${document.documentElement.dataset.theme ?? ""}`;
  }
  let backingScale = 1;
  let visible = typeof document !== "undefined" ? !document.hidden : true;
  let inView = true;
  let unsubPrefs: (() => void) | null = null;
  // Non-reactive copies read by the draw loop, which runs outside Svelte: the
  // effect further down realigns them on every state change.
  let playingRef = false;
  let modeRef: VizMode = "bars";
  let expandedRef = false;
  /** Last known playback position + when it arrived: DiscoWall extrapolates between updates. */
  let timeRef = 0;
  let timeStamp = typeof performance !== "undefined" ? performance.now() : 0;
  let resize: (() => void) | null = null;
  /** How early the synced line switches (s), see `karaokeActive`. */
  const KARAOKE_LEAD_SEC = 0.18;

  const activeMode = $derived((mode ?? prefsMode) as VizMode);

  const parsedLrc = $derived(parseLrcLyrics(lyrics || ""));
  const lrcIdx = $derived(currentLrcLineIndex(parsedLrc, currentTime));
  const currentLrcText = $derived(
    lrcIdx >= 0 ? parsedLrc[lrcIdx]?.text?.trim() || "" : "",
  );
  const previousLrcText = $derived(
    lrcIdx > 0 ? parsedLrc[lrcIdx - 1]?.text?.trim() || "" : "",
  );
  const nextLrcText = $derived(
    lrcIdx >= 0 && lrcIdx + 1 < parsedLrc.length
      ? parsedLrc[lrcIdx + 1]?.text?.trim() || ""
      : "",
  );

  // ---- Karaoke (legacy look: big accent line, dim neighbours, dark stage) --
  // Every line sits in one column that glides (transform only) so the active
  // line stays centred, instead of the three lines being swapped in place.

  /** Lines shown by karaoke: synced LRC, else plain text (legacy fallback). */
  const plainLines = $derived(
    parsedLrc.length || !lyrics.trim()
      ? []
      : lyrics
          .split(/\r?\n/)
          .map((l) => l.replace(/\[[^\]]*]/g, "").trim())
          .filter(Boolean),
  );
  const karaokeSynced = $derived(parsedLrc.length > 0);
  const karaokeLines = $derived(
    karaokeSynced ? parsedLrc.map((l) => l.text.trim()) : plainLines,
  );
  /**
   * Synced: the LRC line, a hair early so the glide ends on the beat (the
   * clock only ticks a few times per second). Plain text: legacy estimate
   * from the progress through the track.
   */
  const karaokeActive = $derived.by(() => {
    if (karaokeSynced) return currentLrcLineIndex(parsedLrc, currentTime + KARAOKE_LEAD_SEC);
    const n = plainLines.length;
    if (!n) return -1;
    const dur = session.duration > 0 ? session.duration : 180;
    const progress = Math.min(0.999, Math.max(0, currentTime / dur));
    return Math.min(n - 1, Math.floor(progress * n));
  });
  /** The line the column is centred on (the first one before the song starts). */
  const karaokeFocus = $derived(Math.max(0, karaokeActive));
  /** Fullscreen backdrop: line start times when synced. */
  const karaokeStarts = $derived(karaokeSynced ? parsedLrc.map((l) => l.atSec) : null);
  const karaokePlainSpan = $derived(
    (session.duration > 0 ? session.duration : 180) / Math.max(1, plainLines.length),
  );
  const karaokeActiveText = $derived(
    karaokeActive >= 0 ? karaokeLines[karaokeActive] || "" : "",
  );

  let karaokeViewport: HTMLDivElement | null = $state(null);
  let karaokeTrack: HTMLDivElement | null = $state(null);
  let karaokeOffset = $state(0);
  /** No glide on the first placement (track change, expand): it would sweep the whole song. */
  let karaokeInstant = $state(true);
  let karaokeSongKey = "";

  function placeKaraoke(instant: boolean) {
    const vp = karaokeViewport;
    const track = karaokeTrack;
    if (!vp || !track) return;
    const line = track.children[karaokeFocus] as HTMLElement | undefined;
    if (!line) return;
    const centre = vp.clientHeight * (expanded ? 0.44 : 0.5);
    const next = Math.round(centre - (line.offsetTop + line.offsetHeight / 2));
    karaokeInstant = instant;
    karaokeOffset = next;
  }

  function clearLoop() {
    cancelAnimationFrame(raf);
    window.clearTimeout(timerId);
    raf = 0;
    timerId = 0;
  }

  function scheduleNext(delayMs: number) {
    if (delayMs <= 4) {
      raf = requestAnimationFrame(step);
      return;
    }
    timerId = window.setTimeout(() => {
      timerId = 0;
      raf = requestAnimationFrame(step);
    }, delayMs);
  }

  function syncAnalyserLease() {
    // Karaoke draws no spectrum; hidden / off-screen panels draw nothing.
    analyserLease.set(visible && inView && playingRef && activeMode !== "karaoke");
  }

  function syncLoop() {
    syncAnalyserLease();
    if (!visible || !inView) {
      clearLoop();
      return;
    }
    if (raf === 0 && timerId === 0) scheduleNext(0);
  }

  /**
   * Playing: throttled loop (≤30 fps, 24 on WebKitGTK). Paused / idle: one
   * calm frame, then the loop stops until something changes (DiscoWall may
   * keep going briefly while its pulse decays).
   */
  function step(t: number) {
    raf = 0;
    const c = canvas;
    if (!c || !visible || !inView) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const cadence =
      modeRef === "discowall"
        ? discowallLoopCadence({ expanded: expandedRef, active: engine.discoActive })
        : vizLoopCadence({
            expanded: expandedRef,
            isPlaying: playingRef,
          });
    const settling = !playingRef && modeRef === "discowall" && engine.discoActive;
    // Timer wakes a little early, rAF aligns to the frame (see NebulaCanvas).
    const interval =
      cadence.minFrameIntervalMs *
      (modeRef === "discowall" ? (DISCO_INTERVAL_STEPS[discoQuality.level] ?? 1) : 1);
    const early = Math.min(10, interval * 0.15);
    const now = performance.now();
    // Playing but no analyser yet (graph not up / no audio): the idle frame is
    // static, so only poll for the analyser instead of repainting it.
    const waitingForData =
      playingRef && engine.lastFrameStatic && lastDrawKey === drawKey() && !player.getAnalyser();
    const due = !waitingForData && (!playingRef || now - lastDraw >= interval - early - 2);
    if (due) {
      lastDraw = now;
      lastDrawKey = drawKey();
      const w = c.width / backingScale;
      const h = c.height / backingScale;
      const liveTime = playingRef ? timeRef + Math.max(0, (t - timeStamp) / 1000) : timeRef;
      const t0 = performance.now();
      engine.drawFrame(ctx, {
        width: w,
        height: h,
        mode: modeRef,
        analyser: playingRef ? player.getAnalyser() : null,
        isPlaying: playingRef,
        expanded: expandedRef,
        currentTime: liveTime,
        trackKey: player.current?.rel_path ?? null,
      });
      if (modeRef === "discowall" && playingRef) {
        const prevLevel = discoQuality.level;
        discoQuality.push(performance.now() - t0);
        // Resolution step: resize the backing store once this frame has
        // scheduled the next one (resize() re-arms the loop when it is idle).
        if ((DISCO_DPR_STEPS[discoQuality.level] ?? 1) !== (DISCO_DPR_STEPS[prevLevel] ?? 1)) {
          queueMicrotask(() => resize?.());
        }
      }
    }
    if (!playingRef && !settling) return;
    if (playingRef && engine.lastFrameStatic && !player.getAnalyser()) {
      scheduleNext(250);
      return;
    }
    scheduleNext(Math.max(1, interval - (performance.now() - lastDraw) - early));
  }

  function collapse() {
    expanded = false;
  }

  function toggleExpanded() {
    expanded = !expanded;
  }

  /**
   * When expanded, move the viz node to document.body (legacy createPortal)
   * while keeping `host` in-flow as size placeholder.
   */
  function portalExpanded(node: HTMLElement, active: boolean) {
    const host = node.parentElement;
    let portaled = false;

    const sync = (on: boolean) => {
      if (on && !portaled) {
        document.body.appendChild(node);
        portaled = true;
      } else if (!on && portaled && host) {
        host.appendChild(node);
        portaled = false;
      }
    };

    sync(active);
    return {
      update(on: boolean) {
        sync(on);
      },
      destroy() {
        sync(false);
      },
    };
  }

  $effect(() => {
    playingRef = playing;
    expandedRef = expanded;
    // Host stays in-flow while wrap is portaled; force visible when expanded.
    if (expanded) inView = true;
    syncLoop();
  });

  $effect(() => {
    timeRef = currentTime;
    timeStamp = performance.now();
  });

  $effect(() => {
    modeRef = activeMode;
    discoQuality.reset();
    engine.resetForMode(activeMode);
    resize?.();
    syncLoop();
  });

  // Re-centre when the active line, the lyrics or the layout change. Runs
  // after the DOM update, so the new line is already measured.
  $effect(() => {
    void karaokeFocus;
    void expanded;
    const lines = karaokeLines;
    if (activeMode !== "karaoke" || !karaokeTrack) return;
    const songKey = `${session.current?.rel_path ?? ""}|${lines.length}|${expanded ? 1 : 0}`;
    const instant = songKey !== karaokeSongKey;
    karaokeSongKey = songKey;
    placeKaraoke(instant);
  });

  $effect(() => {
    const vp = karaokeViewport;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => placeKaraoke(true));
    ro.observe(vp);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  });

  onMount(() => {
    unsubPrefs = subscribeUserPrefs((p) => {
      prefsMode = p.visualizerMode;
      backdropOn = p.karaokeBackdrop;
    });

    const c = canvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const dpr = () =>
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

    const size = () => {
      const p = c.parentElement;
      const lw = p ? p.clientWidth : 400;
      const lh = p ? Math.max(100, p.clientHeight || 200) : 200;
      let s = dpr();
      if (modeRef === "discowall") {
        // Per-pixel wall: legacy draws the panel at 1x, expanded at the lite
        // cap (≤1.5 on WebKitGTK, lower if the adaptive quality steps down).
        s = expandedRef
          ? scaledDpr(canvasDprCap({ lite: true }), vizEngineDprCap(), DISCO_DPR_STEPS[discoQuality.level] ?? 1)
          : 1;
      } else if (expandedRef) {
        s = Math.min(s, modeRef === "signals" ? 1.38 : 1.52);
      } else {
        s = canvasDprCap({ lite: true });
      }
      backingScale = s;
      c.width = Math.max(1, Math.floor(lw * s));
      c.height = Math.max(1, Math.floor(lh * s));
      c.style.width = `${lw}px`;
      c.style.height = `${lh}px`;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      // Resizing clears the bitmap: paint again (paused loops are stopped).
      syncLoop();
    };
    size();
    resize = size;
    const ro = new ResizeObserver(size);
    if (c.parentElement) ro.observe(c.parentElement);

    const io =
      typeof IntersectionObserver !== "undefined" && wrapEl
        ? new IntersectionObserver(
            ([entry]) => {
              inView = Boolean(entry?.isIntersecting);
              syncLoop();
            },
            { rootMargin: "40px" },
          )
        : null;
    if (io && wrapEl) io.observe(wrapEl);

    const onVis = () => {
      visible = !document.hidden;
      syncLoop();
    };
    document.addEventListener("visibilitychange", onVis);

    // Theme switch while paused: the stopped loop must repaint with the new palette.
    const themeMo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => syncLoop())
        : null;
    themeMo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    visible = !document.hidden;
    syncLoop();

    return () => {
      clearLoop();
      resize = null;
      document.removeEventListener("visibilitychange", onVis);
      themeMo?.disconnect();
      io?.disconnect();
      ro.disconnect();
    };
  });

  onDestroy(() => {
    clearLoop();
    analyserLease.dispose();
    unsubPrefs?.();
  });
</script>

<div
  class="viz-host"
  class:is-expanded-host={expanded}
  bind:this={wrapEl}
>
  <div
    class="viz-wrap"
    class:is-expanded={expanded}
    class:is-karaoke={activeMode === "karaoke"}
    use:portalExpanded={expanded}
    role="button"
    tabindex="0"
    aria-label={expanded ? t("player.vizCollapseAria") : t("player.vizExpandAria")}
    onclick={() => toggleExpanded()}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleExpanded();
      }
    }}
  >
    <canvas class="viz-canvas listen-viz" bind:this={canvas} aria-hidden="true"></canvas>

    {#if activeMode === "karaoke"}
      <div
        class="viz-karaoke-overlay"
        class:is-expanded={expanded}
        class:has-backdrop={backdropOn && expanded}
      >
        {#if backdropOn && expanded && karaokeLines.length}
          <KaraokeWords
            lines={karaokeLines}
            active={karaokeActive}
            starts={karaokeStarts}
            fallbackSpan={karaokePlainSpan}
            currentTime={currentTime + (karaokeSynced ? KARAOKE_LEAD_SEC : 0)}
            {playing}
            title={session.current?.title ?? ""}
          />
        {/if}
        {#if karaokeLines.length}
          <div class="kara-viewport" bind:this={karaokeViewport}>
            <div
              class="kara-track"
              class:is-instant={karaokeInstant}
              bind:this={karaokeTrack}
              style:transform={`translate3d(0, ${karaokeOffset}px, 0)`}
            >
              {#each karaokeLines as line, i (i)}
                {@const dist = Math.abs(i - karaokeFocus)}
                <p
                  class="kara-line"
                  class:is-active={i === karaokeActive}
                  class:is-near={dist === 1}
                  class:is-far={dist >= 2}
                  class:is-gone={dist >= 4}
                  class:is-break={!line}
                >
                  {line || "♪"}
                </p>
              {/each}
            </div>
          </div>
          {#if expanded}
            <!-- The backdrop's on/off, saved per account. -->
            <button
              type="button"
              class="kara-backdrop-toggle"
              class:is-on={backdropOn}
              aria-pressed={backdropOn}
              title={backdropOn ? t("listen.karaokeBackdropOn") : t("listen.karaokeBackdropOff")}
              onclick={(event) => {
                event.stopPropagation();
                patchUserPrefs({ karaokeBackdrop: !backdropOn });
              }}
              onkeydown={(event) => event.stopPropagation()}
            >
              <UiIcon name="sparkle" />
              <span>{t("listen.karaokeBackdrop")}</span>
            </button>
          {/if}
          <!-- Screen readers get the sung line only, not the moving column. -->
          <p class="kara-sr" aria-live="polite">{karaokeActiveText}</p>
        {:else}
          <div class="kara-empty">
            <p class="kara-line is-active">{session.current?.title || "…"}</p>
            <p class="kara-empty__hint">{t("listen.karaokeEmpty")}</p>
          </div>
        {/if}
      </div>
    {:else if activeMode === "discowall" && !session.current}
      <div class="viz-discowall-status" role="status">
        <p>{t("viz.discowallIdle")}</p>
      </div>
    {:else if expanded && currentLrcText}
      <div class="viz-lyrics-overlay" aria-live="polite">
        {#if previousLrcText}
          <p class="viz-lyrics-overlay__prev">{previousLrcText}</p>
        {/if}
        <p class="viz-lyrics-overlay__current">{currentLrcText}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .viz-host {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    align-self: stretch;
    border-radius: inherit;
  }

  .viz-host.is-expanded-host {
    background: color-mix(in srgb, var(--rk-surface-3) 55%, transparent);
  }

  .viz-wrap {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    align-self: stretch;
    cursor: zoom-in;
    outline: none;
    border-radius: inherit;
    overflow: hidden;
  }

  .viz-wrap:focus-visible {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, var(--rk-accent-2) 76%, transparent),
      0 0 0 3px color-mix(in srgb, var(--rk-accent-2) 18%, transparent);
  }

  /* One rung below the player so the dock stays visible and clickable. */
  .viz-wrap.is-expanded {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--rk-side-w, 0px);
    /* Between the side rail and the right edge (100% would overflow by the rail). */
    width: auto;
    z-index: calc(var(--rk-z-player) - 1);
    box-sizing: border-box;
    border-radius: 0;
    cursor: zoom-out;
    min-height: 100vh;
    min-height: 100dvh;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
      max(
        env(safe-area-inset-bottom, 0px),
        var(--viz-expanded-bottom-clear, 0px)
      )
      env(safe-area-inset-left, 0px);
    background:
      radial-gradient(
        circle at 50% 50%,
        color-mix(in srgb, var(--rk-page-glow-2, var(--rk-accent-2)) 12%, transparent),
        transparent 55%
      ),
      linear-gradient(
        180deg,
        var(--rk-page-lg-1, var(--rk-bg-deep, var(--rk-bg))) 0%,
        var(--rk-page-lg-2, var(--rk-bg)) 100%
      );
  }

  .viz-canvas,
  .listen-viz {
    width: 100%;
    height: 100%;
    min-height: 0;
    flex: 1;
    display: block;
    border-radius: inherit;
  }

  .viz-wrap.is-expanded .viz-canvas {
    border-radius: 0;
  }

  .viz-discowall-status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    pointer-events: none;
    text-align: center;
    z-index: 2;
  }

  .viz-discowall-status p {
    margin: 0;
    color: color-mix(in srgb, var(--rk-ink, #fff) 72%, transparent);
    font-size: var(--rk-fs-sm);
    font-weight: 600;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
  }

  .viz-lyrics-overlay {
    position: absolute;
    left: max(1rem, env(safe-area-inset-left, 0px) + 0.6rem);
    right: max(1rem, env(safe-area-inset-right, 0px) + 0.6rem);
    bottom: calc(
      max(
          env(safe-area-inset-bottom, 0px),
          var(--viz-expanded-bottom-clear, 0px)
        ) + 1.5rem
    );
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    pointer-events: none;
    text-align: center;
    z-index: 2;
  }

  /* Legacy views/visualizer.css (.viz-lyrics-overlay). */
  .viz-lyrics-overlay__current,
  .viz-lyrics-overlay__prev {
    margin: 0;
    max-width: 90vw;
    align-self: center;
    text-wrap: balance;
    line-height: 1.2;
    text-shadow:
      0 1px 2px rgba(0, 0, 0, 0.62),
      0 6px 26px rgba(0, 0, 0, 0.55);
  }

  .viz-lyrics-overlay__current {
    font-size: clamp(1.12rem, 2.2vw, 2.05rem);
    font-weight: 800;
    color: color-mix(in srgb, var(--rk-accent) 76%, var(--rk-ink) 24%);
  }

  .viz-lyrics-overlay__prev {
    font-size: clamp(0.92rem, 1.55vw, 1.35rem);
    color: color-mix(in srgb, var(--rk-ink) 56%, transparent);
    opacity: 0.52;
  }

  /*
   * Karaoke — legacy look (views/visualizer.css .viz-karaoke-overlay): dark
   * stage (legacy dimmed the canvas with brightness(0.58); a flat veil is the
   * same and costs nothing per frame), big heavy accent line, neighbours at
   * text 58% / opacity 0.56. New: the whole song is one column that glides
   * slowly to keep the active line centred. Only `transform` / `opacity`
   * move; the column is its own layer, so the canvas below never repaints.
   */
  .viz-karaoke-overlay {
    /* The Listen panel is short: a size that leaves the neighbours visible. */
    --kara-size: clamp(1.1rem, 1.9vw, 1.6rem);
    --kara-side-scale: 0.7;
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    text-align: center;
    background: rgba(0, 0, 0, 0.32);
  }

  .viz-karaoke-overlay.is-expanded {
    --kara-size: clamp(2rem, 4.8vw, 4.6rem);
    --kara-side-scale: 0.5;
    background: rgba(0, 0, 0, 0.36);
  }

  .kara-viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
    padding-inline: clamp(1rem, 4vw, 3rem);
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0%,
      #000 18%,
      #000 82%,
      transparent 100%
    );
    mask-image: linear-gradient(to bottom, transparent 0%, #000 18%, #000 82%, transparent 100%);
  }

  .viz-karaoke-overlay.is-expanded .kara-viewport {
    padding-bottom: max(
      env(safe-area-inset-bottom, 0px),
      var(--viz-expanded-bottom-clear, 0px)
    );
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0%,
      #000 16%,
      #000 76%,
      transparent 96%
    );
    mask-image: linear-gradient(to bottom, transparent 0%, #000 16%, #000 76%, transparent 96%);
  }

  .kara-track {
    display: flex;
    flex-direction: column;
    align-items: center;
    will-change: transform;
    /* Slow, soft glide from line to line. */
    transition: transform 0.95s cubic-bezier(0.33, 0, 0.2, 1);
  }

  .kara-track.is-instant {
    transition: none;
  }

  .kara-line {
    margin: 0;
    max-width: min(90vw, 100%);
    padding-block: 0.08em;
    font-size: var(--kara-size);
    font-weight: 850;
    line-height: 1.12;
    letter-spacing: -0.01em;
    text-wrap: balance;
    overflow-wrap: anywhere;
    color: color-mix(in srgb, var(--rk-ink) 58%, transparent);
    opacity: 0.32;
    transform: scale(var(--kara-side-scale));
    transform-origin: center;
    text-shadow: 0 2px 3px rgba(0, 0, 0, 0.6);
    transition:
      transform 0.6s cubic-bezier(0.33, 0, 0.2, 1),
      opacity 0.6s ease,
      color 0.6s ease;
  }

  .kara-line.is-near {
    opacity: 0.56;
  }

  .kara-line.is-far {
    opacity: 0.26;
  }

  .kara-line.is-gone {
    opacity: 0;
  }

  .kara-line.is-break {
    font-weight: 600;
  }

  /*
   * Backdrop on: the dim neighbour lines sit over big words, so they get a
   * dark halo to stand apart and a little more light.
   */
  .has-backdrop .kara-line:not(.is-active) {
    text-shadow:
      0 0 6px rgba(0, 0, 0, 0.9),
      0 0 18px rgba(0, 0, 0, 0.75),
      0 2px 3px rgba(0, 0, 0, 0.6);
  }

  .has-backdrop .kara-line.is-near {
    opacity: 0.72;
  }

  .has-backdrop .kara-line.is-far {
    opacity: 0.38;
  }

  .has-backdrop .kara-line.is-gone {
    opacity: 0;
  }

  .kara-line.is-active {
    opacity: 1;
    transform: scale(1);
    color: color-mix(in srgb, var(--rk-accent) 80%, var(--rk-ink) 20%);
    text-shadow:
      0 2px 3px rgba(0, 0, 0, 0.72),
      0 10px 34px rgba(0, 0, 0, 0.62);
  }

  .kara-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: clamp(1rem, 4vw, 3rem);
  }

  .kara-empty__hint {
    margin: 0;
    font-size: var(--rk-fs-sm);
    font-weight: 600;
    color: color-mix(in srgb, var(--rk-ink) 58%, transparent);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }

  .kara-backdrop-toggle {
    position: absolute;
    top: max(0.9rem, env(safe-area-inset-top, 0px) + 0.6rem);
    right: max(0.9rem, env(safe-area-inset-right, 0px) + 0.6rem);
    z-index: 3;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid color-mix(in srgb, var(--rk-ink) 22%, transparent);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.38);
    color: color-mix(in srgb, var(--rk-ink) 62%, transparent);
    font: inherit;
    font-size: var(--rk-fs-sm);
    font-weight: 650;
    cursor: pointer;
    transition:
      color 0.2s ease,
      border-color 0.2s ease,
      background 0.2s ease;
  }

  .kara-backdrop-toggle.is-on {
    color: var(--rk-ink);
    border-color: color-mix(in srgb, var(--rk-accent-2) 70%, transparent);
    background: color-mix(in srgb, var(--rk-accent-2) 26%, rgba(0, 0, 0, 0.38));
  }

  .kara-backdrop-toggle:hover {
    color: var(--rk-ink);
  }

  .kara-backdrop-toggle:focus-visible {
    outline: 2px solid var(--rk-accent-2);
    outline-offset: 2px;
  }

  .kara-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .kara-track,
    .kara-line {
      transition: none;
    }
  }
</style>
