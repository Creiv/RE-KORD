<script lang="ts">
  let {
    freeBytes,
    totalBytes,
    label,
    valueText,
  }: {
    freeBytes: number;
    totalBytes: number;
    label: string;
    valueText: string;
  } = $props();

  const usedBytes = $derived(Math.max(0, totalBytes - freeBytes));
  const pct = $derived(
    totalBytes > 0
      ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100))
      : 0,
  );
</script>

<p class="disk-meter__value">{valueText}</p>
<div
  class="disk-meter__bar"
  role="meter"
  aria-valuemin={0}
  aria-valuemax={totalBytes}
  aria-valuenow={usedBytes}
  aria-label={label}
>
  <span class="disk-meter__bar-fill" style:width={`${pct}%`}></span>
</div>

<style>
  .disk-meter__value {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--rk-ink);
    letter-spacing: -0.01em;
  }

  .disk-meter__bar {
    margin-top: 0.45rem;
    height: 0.45rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--rk-line) 70%, var(--rk-surface-3) 30%);
    overflow: hidden;
  }

  .disk-meter__bar-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(
      90deg,
      var(--rk-accent),
      color-mix(in srgb, var(--rk-accent-2) 70%, var(--rk-accent) 30%)
    );
  }
</style>
