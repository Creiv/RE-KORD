<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  let {
    value = $bindable(""),
    type = "text",
    class: className = "",
    ...rest
  }: HTMLInputAttributes & { value?: string } = $props();
</script>

<!-- Styles: `@rekord/ui/styles/controls.css` (`.rk-input`). -->
<input class="rk-input {className}" {type} bind:value {...rest} />
