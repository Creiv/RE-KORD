<script lang="ts">
  let {
    title,
    statusOn = false,
    stackedActions = false,
    stretchActions = false,
    children,
    status,
    aside,
    actions,
  }: {
    title: string;
    statusOn?: boolean;
    /** Column layout for actions (e.g. Discogs token + buttons). */
    stackedActions?: boolean;
    /** Full-width action buttons on narrow viewports (YouTube row). */
    stretchActions?: boolean;
    children?: import("svelte").Snippet;
    status?: import("svelte").Snippet;
    aside?: import("svelte").Snippet;
    actions?: import("svelte").Snippet;
  } = $props();
</script>

<div
  class="integration-row"
  class:integration-row--stretch-actions={stretchActions}
>
  <div class="integration-row__body">
    <h3 class="integration-row__title">{title}</h3>
    {@render children?.()}
    {#if status}
      <p class="integration-row__status" class:is-on={statusOn}>
        {@render status()}
      </p>
    {/if}
    {@render aside?.()}
  </div>
  {#if actions}
    <div
      class="integration-row__actions"
      class:integration-row__actions--stacked={stackedActions}
    >
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  .integration-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.85rem;
    padding: 1rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--rk-ink) 10%, transparent);
  }

  .integration-row:first-child {
    padding-top: 0.15rem;
  }

  .integration-row:last-child {
    border-bottom: none;
    padding-bottom: 0.15rem;
  }

  @media (min-width: 720px) {
    .integration-row {
      grid-template-columns: minmax(0, 1fr) minmax(16rem, 24rem);
      align-items: start;
      column-gap: 2rem;
      row-gap: 0.65rem;
    }
  }

  .integration-row__body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
  }

  .integration-row__title {
    margin: 0 0 0.08rem;
    font-size: 0.98rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--rk-ink);
  }

  .integration-row__body :global(.integration-row__lead) {
    margin: 0;
    line-height: 1.45;
    font-size: 0.86rem;
    color: var(--rk-muted);
  }

  .integration-row__status {
    margin: 0.2rem 0 0;
    line-height: 1.4;
    font-size: 0.84rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--rk-ink) 55%, var(--rk-muted) 45%);
  }

  .integration-row__status.is-on {
    color: color-mix(in srgb, var(--rk-accent) 55%, var(--rk-ink) 45%);
  }

  .integration-row__status :global(.integration-row__link) {
    color: color-mix(in srgb, var(--rk-accent-2) 70%, var(--rk-ink) 30%);
    text-decoration: underline;
    text-underline-offset: 0.12em;
    white-space: nowrap;
  }

  .integration-row__status :global(.integration-row__link:hover) {
    color: var(--rk-accent-2);
  }

  .integration-row__body :global(.integration-row__warn) {
    margin: 0.2rem 0 0;
    font-size: 0.84rem;
    line-height: 1.4;
    color: var(--rk-danger, #e85d5d);
  }

  .integration-row__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: 0.45rem;
  }

  @media (min-width: 720px) {
    .integration-row__actions {
      justify-content: flex-end;
      padding-top: 0.1rem;
    }
  }

  .integration-row__actions--stacked {
    flex-direction: column;
    align-items: stretch;
    width: 100%;
  }

  .integration-row__actions--stacked :global(.integration-row__btn-row) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
  }

  .integration-row__actions--stacked :global(.integration-row__btn-row .rk-btn) {
    flex: 1 1 auto;
    min-width: 0;
  }

  @media (max-width: 719px) {
    .integration-row--stretch-actions .integration-row__actions {
      flex-direction: column;
      align-items: stretch;
      width: 100%;
    }

    .integration-row--stretch-actions .integration-row__actions :global(.rk-btn) {
      width: 100%;
      justify-content: center;
    }
  }
</style>
