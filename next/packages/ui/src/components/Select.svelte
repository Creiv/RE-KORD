<script lang="ts">
  import type { SelectOption } from "../types";
  import type { HTMLSelectAttributes } from "svelte/elements";

  let {
    options = [],
    value = $bindable(""),
    placeholder = "",
    class: className = "",
    onchange,
    ...rest
  }: HTMLSelectAttributes & {
    options?: SelectOption[];
    value?: string;
    placeholder?: string;
  } = $props();
</script>

<select class="rk-select {className}" bind:value {onchange} {...rest}>
  {#if placeholder}
    <option value="">{placeholder}</option>
  {/if}
  {#each options as opt}
    <option value={opt.value} disabled={opt.disabled}>{opt.label}</option>
  {/each}
</select>

<style>
  .rk-select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    border-radius: var(--rk-radius);
    padding: 0.6rem 0.75rem;
    color: var(--rk-ink);
    font: inherit;
    max-width: 100%;
    min-height: 2.6rem;
  }

  .rk-select:focus {
    outline: 2px solid color-mix(in srgb, var(--rk-focus) 40%, transparent);
    border-color: var(--rk-accent-2);
  }

  .rk-select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
