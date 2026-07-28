<script lang="ts">
  let { children }: { children: import("svelte").Snippet } = $props();
</script>

<div class="account-list" role="list">
  {@render children()}
</div>

<style>
  .account-list {
    display: grid;
    gap: 0.7rem;
    margin: 0.35rem 0 1rem;
  }
</style>
