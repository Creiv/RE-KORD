<script lang="ts">
  import type { StatItem } from "../types";

  let { items = [] }: { items?: StatItem[] } = $props();
</script>

<dl class="rk-stats">
  {#each items as item}
    <div>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
    </div>
  {/each}
</dl>

<style>
  .rk-stats {
    display: grid;
    gap: 0.75rem;
    margin: 0 0 1.1rem;
  }

  .rk-stats div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid var(--rk-line);
    padding-bottom: 0.55rem;
  }

  dt {
    color: var(--rk-muted);
  }

  dd {
    margin: 0;
    font-weight: 600;
    text-align: right;
  }
</style>
