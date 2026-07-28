<script lang="ts">
  import { formatTime } from "../lib/player";

  let {
    currentTime = 0,
    duration = 0,
    onseek,
  }: {
    currentTime?: number;
    duration?: number;
    onseek: (seconds: number) => void;
  } = $props();

  let railEl: HTMLDivElement | null = $state(null);

  const pct = $derived(duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0);

  function seekFromClientX(clientX: number) {
    if (!railEl || duration <= 0) return;
    const rect = railEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onseek(ratio * duration);
  }

  function onPointerDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  }

  function onPointerMove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    seekFromClientX(e.clientX);
  }
</script>

<div class="timeline">
  <div
    class="progress2"
    role="slider"
    tabindex="0"
    aria-valuemin={0}
    aria-valuemax={Math.floor(duration)}
    aria-valuenow={Math.floor(currentTime)}
    aria-label="Posizione brano"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onkeydown={(e) => {
      if (e.key === "ArrowRight") onseek(Math.min(duration, currentTime + 5));
      if (e.key === "ArrowLeft") onseek(Math.max(0, currentTime - 5));
    }}
  >
    <div class="slot" bind:this={railEl}>
      <div class="rail">
        <div class="fill" style="width: {pct}%"></div>
      </div>
      <div class="thumb" style="left: {pct}%"></div>
    </div>
  </div>
  <div class="times">
    <span>{formatTime(currentTime)}</span>
    <span>{formatTime(duration)}</span>
  </div>
</div>

<style>
  .timeline {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .progress2 {
    position: relative;
    width: 100%;
    padding-block: 0.2rem;
    cursor: pointer;
    touch-action: none;
  }

  .progress2:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 2px;
  }

  .slot {
    position: relative;
    width: 100%;
    height: 14px;
  }

  .rail {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 10px;
    transform: translateY(-50%);
    border-radius: var(--rk-radius-sm);
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .fill {
    height: 100%;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(90deg, var(--rk-accent), var(--rk-accent-2));
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    z-index: 1;
    background: linear-gradient(
      145deg,
      color-mix(in srgb, var(--rk-accent-2) 90%, white 8%),
      color-mix(in srgb, var(--rk-accent) 88%, black 10%)
    );
    border: 1px solid color-mix(in srgb, var(--rk-ink) 22%, transparent);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.32);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .progress2:hover .thumb,
  .progress2:focus-visible .thumb {
    transform: translate(-50%, -50%) scale(1.2);
  }

  .times {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--rk-muted);
    font-variant-numeric: tabular-nums;
    font-family: var(--rk-mono);
  }
</style>
