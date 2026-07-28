<script lang="ts">
  import type { ShortcutItem } from "../lib/shortcutList";

  let { items }: { items: ShortcutItem[] } = $props();
</script>

<div class="shortcut-list">
  {#each items as item (item.id)}
    <div class="shortcut-row">
      {#if item.keys.length > 1}
        <span class="shortcut-keys">
          {#each item.keys as key, i (i)}
            {#if i > 0 && item.keySep}
              <span class="shortcut-keys__sep">{item.keySep}</span>
            {/if}
            <kbd
              class="shortcut-kbd"
              class:shortcut-kbd--solo={key.size === "solo"}
              class:shortcut-kbd--wide={key.size === "wide"}
            >
              {key.text}
            </kbd>
          {/each}
        </span>
      {:else}
        {@const key = item.keys[0]}
        <kbd
          class="shortcut-kbd"
          class:shortcut-kbd--solo={key?.size === "solo"}
          class:shortcut-kbd--wide={key?.size === "wide"}
        >
          {key?.text ?? ""}
        </kbd>
      {/if}
      <span class="shortcut-row__desc">{item.description}</span>
    </div>
  {/each}
</div>

<style>
  .shortcut-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    overflow: hidden;
    background: color-mix(in srgb, var(--rk-surface-3) 55%, var(--rk-surface-2) 45%);
    width: 100%;
  }

  .shortcut-row {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.45rem 0.65rem;
    padding: 0.75rem 0.95rem;
    border-right: 1px solid color-mix(in srgb, var(--rk-line) 82%, transparent);
    min-width: 0;
    box-sizing: border-box;
  }

  .shortcut-keys {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex: 0 0 auto;
  }

  .shortcut-keys__sep {
    font-size: 0.88em;
    color: var(--rk-muted);
  }

  .shortcut-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    font-family: var(--rk-font);
    font-size: 0.82em;
    font-weight: 650;
    line-height: 1.2;
    padding: 0.28em 0.58em;
    border-radius: 6px;
    background: color-mix(in srgb, var(--rk-accent) 13%, var(--rk-surface-3) 87%);
    color: var(--rk-accent);
    border: 1px solid color-mix(in srgb, var(--rk-accent) 34%, var(--rk-line-strong) 66%);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--rk-bg) 52%, transparent);
    box-sizing: border-box;
  }

  .shortcut-kbd--solo {
    min-width: 2.75rem;
  }

  .shortcut-kbd--wide {
    min-width: 4.75rem;
  }

  .shortcut-row__desc {
    flex: 1 1 auto;
    min-width: 0;
    text-align: center;
    color: var(--rk-muted);
    font-size: 0.88rem;
  }

  @media (min-width: 1100px) {
    .shortcut-row:nth-child(2n) {
      border-right: none;
    }

    .shortcut-row:not(:nth-last-child(-n + 2)) {
      border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 82%, transparent);
    }
  }

  @media (max-width: 1099px) {
    .shortcut-row:nth-child(2n) {
      border-right: none;
    }

    .shortcut-row:not(:nth-last-child(-n + 2)) {
      border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 82%, transparent);
    }
  }

  @media (max-width: 720px) {
    .shortcut-list {
      grid-template-columns: minmax(0, 1fr);
    }

    .shortcut-row {
      border-right: none;
      border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 82%, transparent);
    }

    .shortcut-row:last-child {
      border-bottom: none;
    }
  }
</style>
