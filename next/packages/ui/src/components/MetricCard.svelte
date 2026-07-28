<script lang="ts">
  let {
    label,
    value,
  }: {
    label: string;
    value: string | number;
  } = $props();
</script>

<div class="rk-metric">
  <span>{label}</span>
  <strong>{value}</strong>
</div>

<style>
  .rk-metric {
    padding: 0.7rem 0.85rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: color-mix(in srgb, var(--rk-surface-3) 55%, var(--rk-surface-2) 45%);
    display: grid;
    gap: 0.2rem;
  }

  span {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--rk-muted);
  }

  strong {
    font-size: 1.65rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }
</style>
