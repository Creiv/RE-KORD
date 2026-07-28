<script lang="ts">
  let {
    active = false,
    label,
    onclick,
  }: {
    active?: boolean;
    label: string;
    onclick?: () => void;
  } = $props();
</script>

<button class="rk-nav" class:active={active} type="button" {onclick}>
  <span class="bar" aria-hidden="true"></span>
  <span class="label">{label}</span>
</button>

<style>
  .rk-nav {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    text-align: left;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 0.55rem 0.7rem;
    border-radius: var(--rk-radius);
    color: var(--rk-muted);
    font: inherit;
    font-weight: 550;
    cursor: pointer;
  }

  .bar {
    width: 3px;
    height: 1.05rem;
    border-radius: 2px;
    background: transparent;
    flex-shrink: 0;
  }

  .rk-nav:hover {
    background: color-mix(in srgb, var(--rk-surface-3) 80%, transparent);
    color: var(--rk-ink);
  }

  .rk-nav.active {
    background: var(--rk-accent-soft);
    color: var(--rk-ink);
  }

  .rk-nav.active .bar {
    background: linear-gradient(180deg, var(--rk-accent), var(--rk-accent-2));
  }
</style>
