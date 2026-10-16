<script lang="ts">
  import { Button } from "@rekord/ui";
  import { admin } from "../lib/admin.svelte";
  import { formatDateTime, formatNumber, t, tp } from "../lib/i18n.svelte";

  let {
    /** Only the warnings (status page); the library page also shows the counts. */
    warningsOnly = false,
  }: { warningsOnly?: boolean } = $props();

  /** Long lists stay readable; the rest is summarised. */
  const MAX_DIRS = 20;

  const report = $derived(admin.lastScan);
  const notice = $derived(admin.pruneNotice);
  const parked = $derived(admin.parked);
  const unreadable = $derived(report?.unreadableDirs ?? []);
  const locked = $derived(admin.busy || !admin.canManage);
  const parkedTotal = $derived((parked?.favorites ?? 0) + (parked?.playlistTracks ?? 0));

  const counts = $derived(
    report
      ? [
          { label: t("scan.count.scannedFiles"), value: report.scannedFiles },
          { label: t("scan.count.indexed"), value: report.indexedTracks },
          { label: t("scan.count.unchanged"), value: report.unchanged },
          { label: t("scan.count.skipped"), value: report.skipped },
          { label: t("scan.count.errors"), value: report.errors },
          { label: t("scan.count.missing"), value: report.missingTracks ?? 0 },
          { label: t("scan.count.removedTracks"), value: report.removedTracks },
          { label: t("scan.count.removedAlbums"), value: report.removedAlbums },
          { label: t("scan.count.removedArtists"), value: report.removedArtists },
        ]
      : [],
  );
</script>

{#if report && !warningsOnly}
  <div class="report">
    <p class="report-head">
      {t("scan.report.title", {
        mode: t(`scan.mode.${report.mode === "full" ? "full" : "incremental"}`),
        when: formatDateTime(admin.lastScanFinishedAt),
      })}
    </p>
    <dl class="counts">
      {#each counts as c (c.label)}
        <div class="count">
          <dt>{c.label}</dt>
          <dd>{formatNumber(c.value)}</dd>
        </div>
      {/each}
    </dl>
  </div>
{/if}

{#if notice}
  <div class="warn" role="alert">
    <p class="warn-title">{t("scan.prune.title")}</p>
    <p>
      {notice.missing != null
        ? t("scan.prune.bodyCount", { count: formatNumber(notice.missing) })
        : t("scan.prune.body")}
    </p>
    <p>{t("scan.prune.advice")}</p>
    <details class="detail">
      <summary>{t("scan.prune.detail")}</summary>
      <code>{notice.reason}</code>
      {#if notice.at}
        <span class="when">{formatDateTime(notice.at)}</span>
      {/if}
    </details>
    <div class="warn-actions">
      <Button
        variant="secondary"
        tone="danger"
        disabled={locked}
        onclick={() => void admin.confirmFullScan()}
      >
        {t("scan.prune.action")}
      </Button>
    </div>
  </div>
{/if}

{#if unreadable.length > 0}
  <div class="warn soft">
    <p class="warn-title">
      {t("scan.unreadable.title", { count: formatNumber(unreadable.length) })}
    </p>
    <p>{t("scan.unreadable.body")}</p>
    <ul class="dirs">
      {#each unreadable.slice(0, MAX_DIRS) as dir (dir)}
        <li><code>{dir || "/"}</code></li>
      {/each}
    </ul>
    {#if unreadable.length > MAX_DIRS}
      <p class="more">
        {t("scan.unreadable.more", { count: formatNumber(unreadable.length - MAX_DIRS) })}
      </p>
    {/if}
  </div>
{/if}

{#if parked && parkedTotal > 0}
  <div class="warn soft">
    <p class="warn-title">{t("scan.parked.title")}</p>
    <p>
      {t("scan.parked.body", {
        favorites: tp("count.favorites", parked.favorites),
        playlistTracks: tp("count.playlistEntries", parked.playlistTracks),
      })}
    </p>
  </div>
{/if}

<style>
  .report {
    margin-top: 0.9rem;
  }

  .report-head {
    margin: 0 0 0.45rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }

  .counts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.45rem 1rem;
    margin: 0;
  }

  .count {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .count dt {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .count dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .warn {
    --warn: #fbbf24;
    margin-top: 0.9rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
    border-left-width: 3px;
    border-radius: var(--rk-radius);
    background: color-mix(in srgb, var(--warn) 9%, transparent);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .warn.soft {
    --warn: var(--rk-accent);
  }

  .warn p {
    margin: 0 0 0.4rem;
  }

  .warn-title {
    font-weight: 700;
    font-size: var(--rk-fs-md);
  }

  .detail {
    margin: 0.2rem 0 0.5rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
  }

  .detail summary {
    cursor: pointer;
  }

  .detail code {
    display: block;
    margin-top: 0.3rem;
    overflow-wrap: anywhere;
  }

  .when {
    display: block;
    margin-top: 0.2rem;
  }

  .warn-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.3rem;
  }

  .dirs {
    margin: 0.2rem 0 0;
    padding-left: 1.1rem;
    max-height: 12rem;
    overflow-y: auto;
  }

  .dirs code {
    overflow-wrap: anywhere;
  }

  .more {
    margin-top: 0.3rem;
    color: var(--rk-muted);
  }
</style>
