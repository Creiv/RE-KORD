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

<!-- Styles: `@rekord/ui/styles/controls.css` (`.rk-select`). -->
<select class="rk-select {className}" bind:value {onchange} {...rest}>
  {#if placeholder}
    <option value="">{placeholder}</option>
  {/if}
  {#each options as opt}
    <option value={opt.value} disabled={opt.disabled}>{opt.label}</option>
  {/each}
</select>
