<script lang="ts">
  let {
    level = 1,
    pct = 0,
    loading = false,
    active = false,
    title = "",
    ariaLabel = "Livello",
    onclick,
  }: {
    level?: number;
    pct?: number;
    loading?: boolean;
    active?: boolean;
    title?: string;
    ariaLabel?: string;
    onclick?: () => void;
  } = $props();

  const clamped = $derived(Math.min(100, Math.max(0, pct)));
  const tier = $derived(Math.min(8, Math.max(0, Math.floor((level - 1) / 2))));
</script>

<button
  type="button"
  class="btn"
  class:active
  style="--level-ring-pct:{loading ? 0 : clamped}; --level-ring-tier:{tier}"
  {title}
  aria-label={ariaLabel}
  aria-current={active ? "page" : undefined}
  {onclick}
>
  <span class="ring" class:loading aria-hidden="true"></span>
  <span class="hole" aria-hidden="true"></span>
  <span class="level">{loading ? "·" : level}</span>
</button>

<style>
  .btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    border: none;
    border-radius: var(--rk-radius);
    background: transparent;
    color: var(--rk-muted-strong);
    cursor: pointer;
    flex-shrink: 0;
  }

  .btn:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 2px;
  }

  .btn.active .level {
    color: var(--rk-accent-2);
  }

  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from -90deg,
      var(--rk-accent) 0deg,
      color-mix(
          in srgb,
          var(--rk-accent) calc(78% - var(--level-ring-tier, 0) * 2.5%),
          var(--rk-accent-2) calc(22% + var(--level-ring-tier, 0) * 2.5%)
        )
        calc(var(--level-ring-pct) * 3.6deg),
      color-mix(in srgb, var(--rk-line) 82%, transparent)
        calc(var(--level-ring-pct) * 3.6deg),
      color-mix(in srgb, var(--rk-line) 82%, transparent) 360deg
    );
  }

  .ring.loading {
    opacity: 0.42;
    animation: pulse 1.25s ease-in-out infinite;
  }

  .hole {
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: var(--rk-sidebar-bg);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rk-line) 55%, transparent);
  }

  .level {
    position: relative;
    z-index: 1;
    font-size: 0.8125rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--rk-accent);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 0.62;
    }
  }
</style>
