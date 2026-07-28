<script lang="ts">
  let {
    children,
  }: {
    children: import("svelte").Snippet;
  } = $props();
</script>

<div class="rk-actions">
  {@render children()}
</div>

<style>
  .rk-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
  }
</style>
