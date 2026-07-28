<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { loadUserPrefs, type VisualizerMode } from "../../lib/userPrefs";

  let {
    playing = false,
    mode = "bars" as VisualizerMode,
  }: {
    playing?: boolean;
    mode?: VisualizerMode;
  } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);
  let raf = 0;
  let phase = 0;

  function draw() {
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--rk-accent1").trim() ||
      "#6ee7b7";
    const muted =
      getComputedStyle(document.documentElement).getPropertyValue("--rk-text").trim() ||
      "rgba(255,255,255,0.7)";
    phase += playing ? 0.08 : 0.01;
    const bars = 32;
    if (mode === "wave" || mode === "smooth" || mode === "hmb") {
      ctx.beginPath();
      ctx.strokeStyle = accent;
      ctx.lineWidth = mode === "smooth" ? 2.5 : 1.5;
      for (let x = 0; x <= w; x += 4) {
        const t = x / w;
        const amp = playing ? 0.35 : 0.12;
        const y =
          h * 0.55 +
          Math.sin(t * Math.PI * (mode === "hmb" ? 6 : 3) + phase) * h * amp +
          Math.sin(t * Math.PI * 9 + phase * 1.7) * h * amp * 0.35;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (mode === "hmb") {
        ctx.beginPath();
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.45;
        for (let x = 0; x <= w; x += 4) {
          const t = x / w;
          const y = h * 0.45 + Math.sin(t * Math.PI * 4 - phase) * h * 0.18;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (mode === "signals") {
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.strokeStyle = i % 2 ? accent : muted;
        ctx.globalAlpha = 0.35 + i * 0.1;
        const y0 = (h / 6) * (i + 1);
        for (let x = 0; x <= w; x += 3) {
          const y = y0 + Math.sin(x * 0.04 + phase + i) * (playing ? 10 : 3);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      // bars + mirror
      const gap = 2;
      const bw = Math.max(2, (w - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i++) {
        const n = Math.abs(Math.sin(phase + i * 0.35)) * (playing ? 1 : 0.25);
        const bh = Math.max(4, n * h * 0.7);
        const x = i * (bw + gap);
        ctx.fillStyle = accent;
        if (mode === "mirror") {
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, h / 2 - bh / 2, bw, bh);
        } else {
          ctx.fillRect(x, h - bh, bw, bh);
        }
      }
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(draw);
  }

  onMount(() => {
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });

  onDestroy(() => cancelAnimationFrame(raf));

  $effect(() => {
    void mode;
    void playing;
    void loadUserPrefs().visualizerMode;
  });
</script>

<canvas bind:this={canvas} class="listen-viz" aria-hidden="true"></canvas>

<style>
  .listen-viz {
    width: 100%;
    height: 100%;
    display: block;
    border-radius: inherit;
  }
</style>
