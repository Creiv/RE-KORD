<script lang="ts">
  let { children }: { children: import("svelte").Snippet } = $props();
</script>

<div class="integration-list">
  {@render children()}
</div>

<style>
  .integration-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
</style>
