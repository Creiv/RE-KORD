<script lang="ts">
  import {
    ActionRow,
    Banner,
    Button,
    Field,
    Panel,
    Select,
    TextInput,
  } from "@rekord/ui";
  import type { EmbeddedPriority, PreferredLayout } from "../api";
  import { admin, humanTime, LAYOUT_IDS, layoutLabel } from "../lib/admin.svelte";
  import { formatNumber, formatPercent, t, tp } from "../lib/i18n.svelte";
  import ScanReportCard from "./ScanReportCard.svelte";

  let {
    musicRoot = $bindable(""),
    busy = false,
    onsave,
  }: {
    musicRoot?: string;
    busy?: boolean;
    onsave: () => void;
  } = $props();

  const layoutOptions = $derived(LAYOUT_IDS.map((id) => ({ value: id, label: layoutLabel(id) })));

  const layout = $derived(admin.layout);
  const watcher = $derived(admin.watcher);
  const probe = $derived(admin.probe);
  const embedded = $derived(admin.embedded);
  const priorityOptions = $derived([
    { value: "studio", label: t("library.embedded.priorityStudio") },
    { value: "embedded", label: t("library.embedded.priorityEmbedded") },
  ]);
  const locked = $derived(busy || !admin.canManage);
</script>

<Panel title={t("library.root.title")}>
  <Field label={t("library.root.field")}>
    <TextInput bind:value={musicRoot} placeholder={t("library.root.placeholder")} />
  </Field>
  <ActionRow>
    <Button disabled={locked || !musicRoot.trim()} onclick={onsave}>
      {t("library.root.save")}
    </Button>
    <Button
      variant="secondary"
      disabled={locked}
      onclick={() => void admin.runScan("incremental")}
    >
      {t("library.scan.incremental")}
    </Button>
    <Button variant="ghost" disabled={locked} onclick={() => void admin.confirmFullScan()}>
      {t("library.scan.full")}
    </Button>
  </ActionRow>
  <p class="hint">{t("library.scan.hint")}</p>

  <ScanReportCard />
</Panel>

<Panel title={t("library.layout.title")}>
  {#snippet actions()}
    <Button variant="secondary" disabled={busy} onclick={() => void admin.runProbe()}>
      {t("library.layout.probe")}
    </Button>
  {/snippet}

  {#if layout}
    <Field label={t("library.layout.field")}>
      <Select
        options={layoutOptions}
        value={layout.preferredLayout}
        disabled={locked}
        onchange={(e) =>
          void admin.setPreferredLayout(
            (e.currentTarget as HTMLSelectElement).value as PreferredLayout,
          )}
      />
    </Field>
    <label class="check">
      <input
        type="checkbox"
        checked={layout.deepScan}
        disabled={locked}
        onchange={(e) => void admin.toggleDeepScan(e.currentTarget.checked)}
      />
      <span>{t("library.layout.deepScan")}</span>
    </label>
    <p class="hint">
      {t("library.layout.hint", {
        artist: layout.virtualArtist,
        album: layout.virtualAlbum,
      })}
    </p>
  {:else}
    <p class="hint">{t("library.layout.needRoot")}</p>
  {/if}

  {#if probe}
    <div class="probe">
      <p class="probe-line">
        {t("library.probe.summary", {
          tracks: tp("count.tracks", probe.stats.estimatedTracks),
          dirs: tp("count.topDirs", probe.stats.dirsAtRoot),
          depth: formatNumber(probe.stats.maxDepth),
        })}
      </p>
      <ul class="cands">
        {#each probe.candidates as c}
          <li>
            <strong>{layoutLabel(c.layout)}</strong>
            <span class="pct">{formatPercent(c.confidence)}</span>
            <span class="why">{c.reason}</span>
          </li>
        {/each}
      </ul>
      {#each probe.warnings as w}
        <Banner tone="info">{w}</Banner>
      {/each}
      {#if probe.suggestedLayout.preferredLayout !== layout?.preferredLayout}
        <ActionRow>
          <Button disabled={locked} onclick={() => void admin.applyProbeSuggestion()}>
            {t("library.probe.apply")}
          </Button>
        </ActionRow>
      {/if}
    </div>
  {/if}
</Panel>

<Panel title={t("library.watch.title")}>
  {#if watcher}
    <label class="check">
      <input
        type="checkbox"
        checked={watcher.enabled}
        disabled={locked}
        onchange={(e) => void admin.setWatch(e.currentTarget.checked)}
      />
      <span>{t("library.watch.toggle")}</span>
    </label>
    <div class="grid">
      <div class="cell">
        <span class="k">{t("library.watch.state")}</span>
        <span class="v">
          {watcher.running
            ? t("library.watch.listening")
            : !watcher.enabled
              ? t("library.watch.off")
              : musicRoot.trim()
                ? t("library.watch.starting")
                : t("library.watch.waitingRoot")}
        </span>
      </div>
      <div class="cell">
        <span class="k">{t("library.watch.events")}</span>
        <span class="v">{formatNumber(watcher.events)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("library.watch.lastEvent")}</span>
        <span class="v">{humanTime(watcher.lastEventAt)}</span>
      </div>
      <div class="cell">
        <span class="k">{t("library.watch.lastScan")}</span>
        <span class="v">{humanTime(watcher.lastScanAt)}</span>
      </div>
    </div>
    {#if watcher.error}
      <Banner tone="error">{watcher.error}</Banner>
    {/if}
  {/if}
</Panel>

{#if embedded}
  <Panel title={t("library.embedded.title")}>
    <label class="check">
      <input
        type="checkbox"
        checked={embedded.enabled}
        disabled={locked}
        onchange={(e) => void admin.setEmbedded({ enabled: e.currentTarget.checked })}
      />
      <span>{t("library.embedded.toggle")}</span>
    </label>
    <Field label={t("library.embedded.priority")}>
      <Select
        options={priorityOptions}
        value={embedded.priority}
        disabled={locked || !embedded.enabled}
        onchange={(e) =>
          void admin.setEmbedded({
            priority: (e.currentTarget as HTMLSelectElement).value as EmbeddedPriority,
          })}
      />
    </Field>
    <p class="hint">{t("library.embedded.hint")}</p>
    {#if embedded.embedDownloads !== undefined}
      <label class="check">
        <input
          type="checkbox"
          checked={embedded.embedDownloads}
          disabled={locked}
          onchange={(e) => void admin.setEmbedded({ embedDownloads: e.currentTarget.checked })}
        />
        <span>{t("library.embedded.downloadsToggle")}</span>
      </label>
      <p class="hint">{t("library.embedded.downloadsHint")}</p>
    {/if}
    {#if embedded.running || embedded.pendingTracks > 0 || embedded.pendingAlbums > 0}
      <p class="hint">
        {t(embedded.running ? "library.embedded.running" : "library.embedded.pending", {
          tracks: tp("count.tracks", embedded.pendingTracks),
          albums: tp("count.albums", embedded.pendingAlbums),
        })}
      </p>
    {/if}
  </Panel>
{/if}

<Panel title={t("library.maint.title")}>
  <ActionRow>
    <Button
      variant="secondary"
      disabled={locked}
      onclick={() => void admin.rebuildThumbnails()}
    >
      {t("library.maint.thumbs")}
    </Button>
    <Button variant="ghost" disabled={locked} onclick={() => void admin.syncLegacyMeta()}>
      {t("library.maint.legacy")}
    </Button>
    {#if embedded}
      <Button
        variant="secondary"
        disabled={locked || !embedded.enabled}
        onclick={() => void admin.rereadEmbedded()}
      >
        {t("library.maint.reread")}
      </Button>
      {#if embedded.priority === "embedded"}
        <Button
          variant="ghost"
          disabled={locked || !embedded.enabled}
          onclick={() => void admin.rereadEmbedded(true)}
        >
          {t("library.maint.rereadOverride")}
        </Button>
      {/if}
    {/if}
  </ActionRow>
  <p class="hint">{t("library.maint.thumbsHint")}</p>
  {#if embedded}
    <p class="hint">{t("library.maint.rereadHint")}</p>
  {/if}
  <p class="hint">{t("legacy.hint")}</p>
</Panel>

<style>
  .hint {
    margin: 0.6rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    margin: 0.7rem 0 0;
    line-height: var(--rk-lh);
  }

  .check input {
    margin-top: 0.2rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.55rem 1.1rem;
    margin: 0.85rem 0 0;
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

  .probe {
    margin-top: 0.9rem;
  }

  .probe-line {
    margin: 0 0 0.5rem;
    font-size: var(--rk-fs-md);
  }

  .cands {
    margin: 0 0 0.6rem;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .cands li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: var(--rk-fs-sm);
  }

  .pct {
    color: var(--rk-accent);
    font-variant-numeric: tabular-nums;
  }

  .why {
    color: var(--rk-muted);
  }
</style>
