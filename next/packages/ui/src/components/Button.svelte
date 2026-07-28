<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "primary" | "secondary" | "ghost";

  let {
    variant = "primary",
    type = "button",
    disabled = false,
    class: className = "",
    children,
    ...rest
  }: HTMLButtonAttributes & {
    variant?: Variant;
    children: import("svelte").Snippet;
  } = $props();
</script>

<button class="rk-btn {variant} {className}" {type} {disabled} {...rest}>
  {@render children()}
</button>

<style>
  .rk-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border: 0;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    border-radius: var(--rk-radius);
    padding: 0.42rem 0.85rem;
    transition: filter 0.15s ease, background 0.15s ease, opacity 0.15s ease;
  }

  .rk-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .primary {
    background: var(--rk-cta);
    color: var(--rk-accent-ink);
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .secondary {
    background: var(--rk-surface-3);
    color: var(--rk-ink);
    border: 1px solid var(--rk-line);
  }

  .ghost {
    background: transparent;
    color: var(--rk-muted-strong);
    border: 1px solid var(--rk-line);
  }

  .ghost:hover:not(:disabled) {
    color: var(--rk-ink);
    border-color: var(--rk-line-strong);
  }
</style>
