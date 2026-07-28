<script lang="ts">
  let { children }: { children: import("svelte").Snippet } = $props();
</script>

<div class="settings-fields-grid">
  {@render children()}
</div>

<style>
  .settings-fields-grid {
    display: grid;
    gap: 0.15rem 1rem;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    min-width: 0;
  }

  .settings-fields-grid :global(.rk-field) {
    margin-bottom: 0.55rem;
  }

  .settings-fields-grid :global(.settings-fields-grid__span) {
    min-width: 0;
  }

  @media (min-width: 760px) {
    .settings-fields-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }

    .settings-fields-grid :global(.settings-fields-grid__span) {
      grid-column: 1 / -1;
    }
  }
</style>
