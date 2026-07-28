<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  let {
    value = $bindable(""),
    type = "text",
    class: className = "",
    ...rest
  }: HTMLInputAttributes & { value?: string } = $props();
</script>

<input class="rk-input {className}" {type} bind:value {...rest} />

<style>
  .rk-input {
    width: 100%;
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    border-radius: var(--rk-radius);
    padding: 0.6rem 0.75rem;
    color: var(--rk-ink);
    font: inherit;
  }

  .rk-input::placeholder {
    color: var(--rk-muted);
  }

  .rk-input:focus {
    outline: 2px solid color-mix(in srgb, var(--rk-focus) 45%, transparent);
    border-color: var(--rk-accent-2);
  }
</style>
