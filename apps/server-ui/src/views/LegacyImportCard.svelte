<script lang="ts">
  import type { LegacyAccountReport, LegacyImportCounts, LegacyImportReport } from "../api";
  import { formatDateTime, formatNumber, t, tp } from "../lib/i18n.svelte";

  let { report }: { report: LegacyImportReport } = $props();

  /** Unmatched paths listed per account; the hub sends at most 50. */
  const MAX_PATHS = 50;

  const COUNT_KEYS: (keyof LegacyImportCounts)[] = [
    "favorites",
    "playlists",
    "playlistTracks",
    "moods",
    "excludedTracks",
    "excludedAlbums",
    "playCounts",
    "recent",
    "settings",
    "plectrBests",
    "selections",
    "themeBackgrounds",
  ];

  const totals = $derived(
    COUNT_KEYS.map((k) => ({ key: k, label: t(`backup.legacy.count.${k}`), value: report.totals[k] })),
  );
  /** Deleted-in-legacy folders go in one line, not one row each. */
  const rows = $derived(report.accounts.filter((a) => a.reason !== "not_registered"));
  const notRegistered = $derived(report.accounts.filter((a) => a.reason === "not_registered"));

  function accountLabel(a: LegacyAccountReport): string {
    const legacy = a.legacyName ?? a.legacyId;
    const hub = a.hubName ?? a.hubId;
    return legacy === hub ? legacy : `${legacy} → ${hub}`;
  }

  /** Non-zero counts of one account, short. */
  function added(a: LegacyAccountReport): string {
    const parts = COUNT_KEYS.filter((k) => a.counts[k] > 0).map(
      (k) => `${formatNumber(a.counts[k])} ${t(`backup.legacy.count.${k}`).toLowerCase()}`,
    );
    return parts.length ? parts.join(", ") : t("backup.legacy.nothingNew");
  }

  function statusText(a: LegacyAccountReport): string {
    const status = t(`backup.legacy.status.${a.status}`);
    return a.reason && a.status !== "imported"
      ? `${status}: ${t(`backup.legacy.reason.${a.reason}`)}`
      : status;
  }
</script>

<div class="report">
  <p class="report-head">
    {t(report.dryRun ? "backup.legacy.resultPreview" : "backup.legacy.result", {
      when: formatDateTime(report.ranAt),
    })}
  </p>
  <dl class="counts">
    {#each totals as c (c.key)}
      <div class="count">
        <dt>{c.label}</dt>
        <dd>{formatNumber(c.value)}</dd>
      </div>
    {/each}
  </dl>
  {#if report.accountsAdded > 0}
    <p class="note">{tp("backup.legacy.accountsAdded", report.accountsAdded)}</p>
  {/if}
  {#if report.metadataError}
    <p class="note warn">{t("backup.legacy.metadataError", { error: report.metadataError })}</p>
  {/if}

  {#if rows.length > 0}
    <table class="accounts">
      <thead>
        <tr>
          <th scope="col">{t("backup.legacy.col.account")}</th>
          <th scope="col">{t("backup.legacy.col.status")}</th>
          <th scope="col">{t("backup.legacy.col.added")}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as a (a.legacyId)}
          <tr data-status={a.status}>
            <td>
              {accountLabel(a)}
              {#if a.created}<span class="badge">{t("backup.legacy.created")}</span>{/if}
            </td>
            <td>{statusText(a)}</td>
            <td>
              {a.status === "imported" ? added(a) : "—"}
              {#if a.unmatchedCount > 0 || a.unmatchedAlbumKeys.length > 0}
                <details class="detail">
                  <summary>
                    {tp("backup.legacy.unmatched", a.unmatchedCount + a.unmatchedAlbumKeys.length)}
                  </summary>
                  <ul class="paths">
                    {#each a.unmatchedPaths.slice(0, MAX_PATHS) as p (p)}
                      <li><code>{p}</code></li>
                    {/each}
                    {#each a.unmatchedAlbumKeys as k (k)}
                      <li><code>{k}</code></li>
                    {/each}
                  </ul>
                  {#if a.unmatchedCount > a.unmatchedPaths.length}
                    <p class="more">
                      {t("backup.legacy.unmatchedMore", {
                        n: formatNumber(a.unmatchedCount - a.unmatchedPaths.length),
                      })}
                    </p>
                  {/if}
                </details>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if notRegistered.length > 0}
    <p class="note">
      {tp("backup.legacy.notRegistered", notRegistered.length)}
    </p>
  {/if}
</div>

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

  .note {
    margin: 0.6rem 0 0;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }

  .note.warn {
    color: #fbbf24;
  }

  .accounts {
    width: 100%;
    margin-top: 0.8rem;
    border-collapse: collapse;
    font-size: var(--rk-fs-sm);
  }

  .accounts th,
  .accounts td {
    padding: 0.35rem 0.5rem 0.35rem 0;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--rk-border, color-mix(in srgb, currentColor 12%, transparent));
    overflow-wrap: anywhere;
  }

  .accounts th {
    font-size: var(--rk-fs-xs);
    font-weight: 600;
    color: var(--rk-muted);
  }

  .accounts tr[data-status="unchanged"] td,
  .accounts tr[data-status="skipped"] td {
    color: var(--rk-muted);
  }

  .badge {
    margin-left: 0.35rem;
    padding: 0 0.35rem;
    border-radius: var(--rk-radius);
    background: color-mix(in srgb, var(--rk-accent) 18%, transparent);
    font-size: var(--rk-fs-xs);
  }

  .detail {
    margin-top: 0.25rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
  }

  .detail summary {
    cursor: pointer;
  }

  .paths {
    margin: 0.25rem 0 0;
    padding-left: 1.1rem;
    max-height: 12rem;
    overflow-y: auto;
  }

  .more {
    margin: 0.25rem 0 0;
  }
</style>
