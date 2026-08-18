<script lang="ts">
  let {
    label,
    children,
  }: {
    label: string;
    children: import("svelte").Snippet;
  } = $props();
</script>

<label class="rk-field">
  <span>{label}</span>
  {@render children()}
</label>

<style>
  .rk-field {
    display: grid;
    gap: 0.35rem;
    font-size: var(--rk-fs-md);
    color: var(--rk-muted);
    margin-bottom: 0.65rem;
  }

  .rk-field:last-child {
    margin-bottom: 0;
  }

  .rk-field :global(.rk-input) {
    color: var(--rk-ink);
  }
</style>
