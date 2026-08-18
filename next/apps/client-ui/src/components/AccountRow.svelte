<script lang="ts">
  import { Button } from "@rekord/ui";

  let {
    name,
    selected = false,
    busy = false,
    level = null as number | null,
    levelTitle = "",
    levelLabel = "",
    defaultBadge = "",
    removeLabel,
    removeDisabled = false,
    removeTitle = undefined as string | undefined,
    onselect,
    onremove,
  }: {
    name: string;
    selected?: boolean;
    busy?: boolean;
    level?: number | null;
    levelTitle?: string;
    levelLabel?: string;
    defaultBadge?: string;
    removeLabel: string;
    removeDisabled?: boolean;
    removeTitle?: string;
    onselect: () => void;
    onremove: () => void;
  } = $props();

  const initial = $derived((name.trim()[0] || "?").toUpperCase());
</script>

<div class="account-row" class:is-selected={selected} role="listitem">
  <button
    type="button"
    class="account-row__main"
    disabled={busy || selected}
    onclick={onselect}
  >
    <span class="account-row__avatar" aria-hidden="true">{initial}</span>
    <span class="account-row__text">
      <span class="account-row__name">{name}</span>
      {#if level != null}
        <span class="account-row__level-pill" title={levelTitle || undefined}>
          {levelLabel}
        </span>
      {:else if defaultBadge}
        <span class="account-row__badge">{defaultBadge}</span>
      {/if}
    </span>
  </button>
  <Button
    variant="ghost"
    disabled={busy || removeDisabled}
    title={removeTitle}
    onclick={onremove}
  >
    {removeLabel}
  </Button>
</div>

<style>
  .account-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.7rem;
    align-items: center;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    background: color-mix(in srgb, var(--rk-surface-2) 78%, transparent);
  }

  .account-row.is-selected {
    border-color: color-mix(in srgb, var(--rk-accent) 42%, var(--rk-line) 58%);
    background: color-mix(in srgb, var(--rk-accent) 11%, var(--rk-surface-2) 89%);
  }

  .account-row__main {
    min-width: 0;
    display: grid;
    grid-template-columns: 2.25rem minmax(0, 1fr);
    gap: 0.75rem;
    align-items: center;
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
  }

  .account-row__main:disabled {
    cursor: default;
  }

  .account-row__avatar {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--rk-radius-round);
    background: color-mix(in srgb, var(--rk-accent) 18%, var(--rk-surface-3) 82%);
    color: var(--rk-accent);
    font-weight: 850;
  }

  .account-row__text {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }

  .account-row__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--rk-fs-md);
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: var(--rk-lh-snug);
  }

  .account-row__badge,
  .account-row__level-pill {
    flex: 0 0 auto;
    font-size: var(--rk-fs-3xs);
    font-weight: 750;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1;
    padding: 0.32em 0.62em;
    border-radius: var(--rk-radius-round);
    border: 1px solid color-mix(in srgb, var(--rk-accent) 30%, var(--rk-line) 70%);
    background: color-mix(in srgb, var(--rk-accent) 8%, var(--rk-surface-3) 92%);
    color: color-mix(in srgb, var(--rk-accent) 80%, var(--rk-muted) 20%);
    white-space: nowrap;
  }

  .account-row.is-selected .account-row__name {
    color: color-mix(in srgb, var(--rk-accent) 18%, var(--rk-ink) 82%);
  }

  .account-row.is-selected .account-row__level-pill {
    border-color: color-mix(in srgb, var(--rk-accent) 44%, var(--rk-line) 56%);
    background: color-mix(in srgb, var(--rk-accent) 14%, var(--rk-surface-3) 86%);
    color: color-mix(in srgb, var(--rk-accent) 92%, var(--rk-ink) 8%);
  }

  /* Telefono: la pillola del livello scende sotto il nome. Accanto ad esso, in
     150px che restano fra avatar e bottone, mangiava metà riga e i nomi finivano
     tutti in «TestAcc…» — e il nome è l'unica cosa che distingue una riga. */
  @media (max-width: 559.98px) {
    .account-row__text {
      grid-template-columns: minmax(0, 1fr);
      justify-items: start;
      gap: 0.2rem;
    }
  }
</style>
