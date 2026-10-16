<script lang="ts">
  import { Button, EmptyState, Panel } from "@rekord/ui";
  import { admin, humanBytes, humanDuration, humanTime, layoutLabel } from "../lib/admin.svelte";
  import { formatNumber, t } from "../lib/i18n.svelte";
  import type { JsRuntimeStatus } from "../api";

  const diag = $derived(admin.diagnostics);

  const JS_LABELS: Record<string, string> = {
    deno: "Deno",
    node: "Node.js",
    bun: "Bun",
    quickjs: "QuickJS",
  };

  function jsRuntimeLine(r: JsRuntimeStatus) {
    const name = r.name ? (JS_LABELS[r.name] ?? r.name) : "?";
    return r.version ? `${name} ${r.version}` : name;
  }

  function binaryLine(b?: { available: boolean; path?: string | null; version?: string | null }) {
    if (!b) return "—";
    if (!b.available) return t("common.notFound");
    return b.version || b.path || t("common.available");
  }
</script>

<Panel title={t("nav.diagnostics")}>
  {#snippet actions()}
    <Button
      variant="secondary"
      disabled={admin.busy}
      onclick={() => void admin.loadSection("diagnostics")}
    >
      {t("common.refresh")}
    </Button>
  {/snippet}

  {#if diag}
    <div class="grid">
      <div class="cell">
        <span class="k">{t("diag.version")}</span><span class="v">{diag.version}</span>
      </div>
      <div class="cell">
        <span class="k">{t("stats.uptime")}</span>
        <span class="v">{humanDuration(diag.uptimeSecs)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("status.database")}</span>
        <span class="v">{humanBytes(diag.db.sizeBytes)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("stats.lastScan")}</span>
        <span class="v">{humanTime(diag.db.lastScanAt)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("diag.disk")}</span>
        <span class="v">
          {t("diag.diskFree", {
            free: humanBytes(diag.disk?.availableBytes),
            total: humanBytes(diag.disk?.totalBytes),
          })}
        </span>
      </div>
      <div class="cell">
        <span class="k">{t("diag.layout")}</span>
        <span class="v">{layoutLabel(diag.layout?.preferredLayout)}</span>
      </div>
      <div class="cell">
        <span class="k">yt-dlp</span><span class="v">{binaryLine(diag.binaries.ytdlp)}</span>
      </div>
      {#if diag.binaries.jsRuntime}
        {@const js = diag.binaries.jsRuntime}
        <div class="cell">
          <span class="k">{t("diag.jsRuntime")}</span>
          {#if js.available}
            <span class="v">{jsRuntimeLine(js)}</span>
          {:else if js.disabled}
            <span class="v">{t("diag.jsDisabled")}</span>
          {:else}
            <span class="v warn">{t("diag.jsMissing")}</span>
          {/if}
        </div>
      {/if}
      <div class="cell">
        <span class="k">ffmpeg</span><span class="v">{binaryLine(diag.binaries.ffmpeg)}</span>
      </div>
      <div class="cell">
        <span class="k">ffprobe</span><span class="v">{binaryLine(diag.binaries.ffprobe)}</span>
      </div>
      <div class="cell">
        <span class="k">cloudflared</span>
        <span class="v">
          {diag.binaries.cloudflared.available ? t("common.available") : t("common.notFound")}
        </span>
      </div>
    </div>
  {:else}
    <EmptyState message={t("diag.unavailable")} />
  {/if}
</Panel>

<Panel title={t("diag.errors.title")}>
  {#snippet actions()}
    <Button
      variant="ghost"
      disabled={admin.busy || (diag?.errors.count ?? 0) === 0}
      onclick={() => void admin.clearErrors()}
    >
      {t("diag.errors.clear")}
    </Button>
  {/snippet}

  {#if !diag || diag.errors.recent.length === 0}
    <EmptyState message={t("diag.errors.empty")} />
  {:else}
    <p class="count">
      {t("diag.errors.count", {
        total: formatNumber(diag.errors.count),
        shown: formatNumber(diag.errors.recent.length),
      })}
    </p>
    <ul class="errors">
      {#each diag.errors.recent as e}
        <li>
          <span class="lvl" data-level={e.level.toLowerCase()}>{e.level}</span>
          <span class="msg">{e.message}</span>
          <span class="src">{e.target} · {humanTime(e.ts)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.55rem 1.1rem;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .k {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .v {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .v.warn {
    font-weight: 500;
    color: var(--rk-warning, #f59e0b);
  }

  .count {
    margin: 0 0 0.6rem;
    font-size: var(--rk-fs-sm);
    color: var(--rk-muted);
  }

  .errors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .errors li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.6rem;
    border-left: 2px solid var(--rk-line);
    padding-left: 0.6rem;
    min-width: 0;
  }

  .lvl {
    font-size: var(--rk-fs-2xs);
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--rk-muted);
  }

  .lvl[data-level="error"] {
    color: #f87171;
  }

  .lvl[data-level="warn"] {
    color: #fbbf24;
  }

  .msg {
    overflow-wrap: anywhere;
  }

  .src {
    grid-column: 2;
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
    overflow-wrap: anywhere;
  }
</style>
