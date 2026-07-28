<script lang="ts">
  import { Button } from "@rekord/ui";
  import UiIcon from "./icons/UiIcon.svelte";

  let {
    label = "Shuffle",
    disabled = false,
    onclick,
  }: {
    label?: string;
    disabled?: boolean;
    onclick?: () => void;
  } = $props();
</script>

<Button class="play-collection-btn" {disabled} {onclick}>
  <UiIcon name="shuffle" />
  {label}
</Button>
