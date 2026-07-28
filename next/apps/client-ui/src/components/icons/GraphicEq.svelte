<script lang="ts">
  let {
    animated = false,
    class: className = "",
  }: {
    animated?: boolean;
    class?: string;
  } = $props();

  const CENTER = 12;
  const BARS = [
    { cx: 8, bottom: 18, h: 12 },
    { cx: 12, bottom: 22, h: 20 },
    { cx: 4, bottom: 14, h: 4 },
    { cx: 16, bottom: 18, h: 12 },
    { cx: 20, bottom: 14, h: 4 },
  ] as const;
  const PULSE = [
    { min: 0.4, dur: 0.68, delay: 0 },
    { min: 0.55, dur: 0.52, delay: 80 },
    { min: 0.35, dur: 0.88, delay: 160 },
    { min: 0.45, dur: 0.62, delay: 40 },
    { min: 0.3, dur: 0.76, delay: 200 },
  ] as const;
  const SPLINE = "0.42 0 0.58 1;0.42 0 0.58 1";

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pulse = $derived(animated && !reduceMotion);

  function segs(bar: (typeof BARS)[number]) {
    const top = bar.bottom - bar.h;
    return {
      top,
      upperH: Math.max(0, CENTER - top),
      lowerH: Math.max(0, bar.bottom - CENTER),
    };
  }
</script>

<svg class="geq {className}" viewBox="0 0 24 24" aria-hidden="true">
  {#each BARS as bar, i}
    {@const anim = PULSE[i]}
    {@const s = segs(bar)}
    {#if !pulse}
      <rect x={bar.cx - 1} y={s.top} width="2" height={bar.h} fill="currentColor" />
    {:else}
      <g>
        {#if s.upperH > 0}
          <rect x={bar.cx - 1} y={s.top} width="2" height={s.upperH} fill="currentColor">
            <animate
              attributeName="height"
              values={`${s.upperH * anim.min};${s.upperH};${s.upperH * anim.min}`}
              dur={`${anim.dur}s`}
              begin={`${anim.delay}ms`}
              repeatCount="indefinite"
              calcMode="spline"
              keySplines={SPLINE}
              keyTimes="0;0.5;1"
            />
            <animate
              attributeName="y"
              values={`${CENTER - s.upperH * anim.min};${s.top};${CENTER - s.upperH * anim.min}`}
              dur={`${anim.dur}s`}
              begin={`${anim.delay}ms`}
              repeatCount="indefinite"
              calcMode="spline"
              keySplines={SPLINE}
              keyTimes="0;0.5;1"
            />
          </rect>
        {/if}
        {#if s.lowerH > 0}
          <rect x={bar.cx - 1} y={CENTER} width="2" height={s.lowerH} fill="currentColor">
            <animate
              attributeName="height"
              values={`${s.lowerH * anim.min};${s.lowerH};${s.lowerH * anim.min}`}
              dur={`${anim.dur}s`}
              begin={`${anim.delay}ms`}
              repeatCount="indefinite"
              calcMode="spline"
              keySplines={SPLINE}
              keyTimes="0;0.5;1"
            />
          </rect>
        {/if}
      </g>
    {/if}
  {/each}
</svg>

<style>
  .geq {
    width: 1.25rem;
    height: 1.25rem;
    display: block;
  }
</style>
