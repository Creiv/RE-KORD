<script lang="ts">
  let {
    active = false,
    disabled = false,
    label,
    onclick,
    children,
  }: {
    active?: boolean;
    disabled?: boolean;
    label: string;
    onclick?: () => void;
    children: import("svelte").Snippet;
  } = $props();
</script>

<button
  class="rk-rail-btn"
  class:active={active}
  type="button"
  title={label}
  aria-label={label}
  {disabled}
  {onclick}
>
  <span class="icon" aria-hidden="true">{@render children()}</span>
  <span class="sr-only">{label}</span>
</button>

<style>
  .rk-rail-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: 0 auto;
    padding: 0;
    border: none;
    border-radius: var(--rk-radius);
    background: transparent;
    color: var(--rk-muted-strong);
    cursor: pointer;
    transition:
      background 0.14s ease,
      color 0.14s ease,
      box-shadow 0.14s ease;
  }

  .rk-rail-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rk-accent) 9%, var(--rk-surface-3) 91%);
    color: var(--rk-ink);
  }

  .rk-rail-btn.active {
    background: color-mix(in srgb, var(--rk-accent) 14%, var(--rk-surface-3) 86%);
    color: var(--rk-ink);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rk-accent) 28%, transparent);
  }

  .rk-rail-btn.active::before {
    content: "";
    position: absolute;
    left: -0.4em;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 1.25rem;
    border-radius: 2px;
    background: linear-gradient(180deg, var(--rk-accent), var(--rk-accent-2));
  }

  .rk-rail-btn.active :global(svg) {
    color: var(--rk-accent-2);
  }

  .rk-rail-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .rk-rail-btn:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 2px;
  }

  .icon {
    display: flex;
    width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
  }

  .icon :global(svg) {
    width: 1.25rem;
    height: 1.25rem;
    display: block;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
