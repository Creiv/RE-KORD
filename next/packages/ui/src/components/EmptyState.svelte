<script lang="ts">
  let { message = "Nessun elemento" }: { message?: string } = $props();
</script>

<p class="rk-empty">{message}</p>

<style>
  .rk-empty {
    margin: 0;
    padding: 2rem 0;
    color: var(--rk-muted);
  }
</style>
