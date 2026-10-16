<script lang="ts">
  /**
   * Dashboard › Qualità libreria. Counts come from the hub (`library/stats`,
   * per account) when it sends them; older hubs: computed from the catalog.
   * Skeletons until the numbers are known — never a 0 that jumps to 48.
   */
  import { Panel, Skeleton } from "@rekord/ui";
  import SectionHeadLead from "../../SectionHeadLead.svelte";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { t } from "../../../lib/i18n.svelte";
  import { session } from "../../../lib/session.svelte";
  import type { QualityIssue } from "../../../lib/libraryQuality";
  import type { QualityCounts } from "./dashboardStats";

  let {
    counts,
    onopen,
  }: {
    counts: QualityCounts | null;
    /** A row was clicked: show the "Da sistemare" list on that issue. */
    onopen?: (issue: QualityIssue) => void;
  } = $props();

  const alerts = $derived(
    counts
      ? [
          { id: "albums-without-cover" as const, value: counts.albumsWithoutCover, icon: "image" as const, tone: "warn" },
          { id: "albums-without-meta" as const, value: counts.albumsWithoutMeta, icon: "album" as const, tone: "warn" },
          { id: "tracks-without-meta" as const, value: counts.tracksWithoutMeta, icon: "note" as const, tone: "warn" },
          { id: "loose-albums" as const, value: counts.looseAlbums, icon: "list" as const, tone: "info" },
        ]
      : [],
  );

  function openStudio() {
    session.studioPane = "meta";
    session.navigate("studio");
  }
</script>

{#snippet rowBody(alert: (typeof alerts)[number])}
  <span class="dash-quality__ic"><UiIcon name={alert.icon} /></span>
  <span class="dash-quality__label">{t(`dashboard.alert.${alert.id}`)}</span>
  {#if alert.value === 0}
    <span class="dash-quality__ok" title={t("dashboard.qualityOk")}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.2 4.2L19 7" /></svg>
      <span class="visually-hidden">{t("dashboard.qualityOk")}</span>
    </span>
  {:else}
    <strong class="dash-quality__value">{alert.value}</strong>
  {/if}
{/snippet}

<Panel class="session-card dashboard-session-card dashboard-page__tile dashboard-page__tile--quality">
  <header class="section-head section-head--page-toolbar">
    <SectionHeadLead eyebrow={t("dashboard.qualityEyebrow")} title={t("dashboard.qualityTitle")}>
      <UiIcon name="build" />
    </SectionHeadLead>
    <div class="section-head__tools">
      <button type="button" class="text-btn" onclick={openStudio}>{t("dashboard.goStudio")}</button>
    </div>
  </header>
  {#if !counts}
    <Skeleton variant="row" count={4} label={t("dashboard.loading")} />
  {:else}
    <ul class="dash-quality">
      {#each alerts as alert (alert.id)}
        {@const state = alert.value === 0 ? "ok" : alert.tone}
        <li class="dash-quality__item">
          {#if onopen}
            <button
              type="button"
              class="dash-quality__row dash-quality__row--{state} dash-quality__row--action"
              onclick={() => onopen(alert.id)}
            >
              {@render rowBody(alert)}
            </button>
          {:else}
            <div class="dash-quality__row dash-quality__row--{state}">{@render rowBody(alert)}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .dash-quality {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .dash-quality__item {
    display: block;
  }

  .dash-quality__row {
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    color: inherit;
    text-align: start;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.7rem;
    padding: 0.65rem 0.85rem;
    border-radius: var(--rk-radius-lg);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-2);
  }

  .dash-quality__row--action {
    cursor: pointer;
  }

  .dash-quality__row--action:hover {
    border-color: color-mix(in srgb, var(--rk-accent) 45%, var(--rk-line));
  }

  .dash-quality__row--action:focus-visible {
    outline: 2px solid var(--rk-accent);
    outline-offset: 2px;
  }

  .dash-quality__row--warn {
    border-color: color-mix(in srgb, var(--rk-warning) 45%, var(--rk-line));
    background: color-mix(in srgb, var(--rk-warning) 6%, var(--rk-surface-2));
  }

  .dash-quality__row--info {
    border-color: color-mix(in srgb, var(--rk-accent-2) 40%, var(--rk-line));
  }

  .dash-quality__ic {
    display: grid;
    place-items: center;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 999px;
    background: var(--rk-surface);
    color: var(--rk-muted);
  }

  .dash-quality__row--warn .dash-quality__ic {
    color: var(--rk-warning);
    background: var(--rk-warning-soft, var(--rk-surface));
  }

  .dash-quality__row--info .dash-quality__ic {
    color: var(--rk-accent-2);
  }

  .dash-quality__row--ok .dash-quality__ic {
    color: var(--rk-success);
    background: var(--rk-success-soft, var(--rk-surface));
  }

  .dash-quality__ic :global(svg),
  .dash-quality__ok :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
  }

  .dash-quality__label {
    min-width: 0;
    font-size: var(--rk-fs-sm);
    font-weight: 600;
    color: var(--rk-ink);
  }

  .dash-quality__value {
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .dash-quality__row--warn .dash-quality__value {
    color: var(--rk-warning);
  }

  .dash-quality__ok {
    color: var(--rk-success);
    display: inline-flex;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
