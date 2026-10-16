<script lang="ts">
  import { Button, Modal } from "@rekord/ui";
  import { t, tp } from "../../lib/i18n.svelte";
  import { downloadFlow } from "../../lib/studio/downloadFlow.svelte";
  import UiIcon from "../icons/UiIcon.svelte";

  /** Mounted once (StudioView): renders the request `downloadFlow` holds. */
  const req = $derived(downloadFlow.current);
  const inLibrary = $derived(req?.ask.library ?? null);
  const danger = $derived(!!req && (req.artistFolderTarget || !!inLibrary));
  const kindLabel = $derived(
    req?.ask.scope === "playlist" ? t("studio.dl.kind.playlist") : t("studio.dl.kind.single"),
  );
</script>

{#if req}
  {#key req.id}
    <Modal
      open
      title={t("ui.studioDownload.confirmTitle")}
      panelClass="rk-confirm studio-dl-confirm"
      onclose={() => downloadFlow.settle(req.id, "cancel")}
    >
      <div class="studio-dl-confirm__item">
        <span class="studio-dl-confirm__art" aria-hidden="true">
          {#if req.ask.thumbnailUrl}
            <img src={req.ask.thumbnailUrl} alt="" width="56" height="56" loading="lazy" />
          {:else}
            <UiIcon name={req.ask.scope === "playlist" ? "album" : "music"} />
          {/if}
        </span>
        <span class="studio-dl-confirm__text">
          <span class="studio-dl-confirm__title">{req.ask.title}</span>
          <span class="studio-dl-confirm__meta">
            {req.ask.subtitle || kindLabel}
          </span>
        </span>
        {#if inLibrary}
          <span class="studio-inlib-badge">{t("studio.dl.inLibrary")}</span>
        {/if}
      </div>

      {#if req.destIssue}
        <p class="studio-dl-confirm__warn" role="alert">
          {req.destIssue === "pickDest" ? t("studio.dl.confirm.pickDestLead") : t("studio.dl.errSingleNeedsAlbum")}
        </p>
      {:else}
        <dl class="studio-dl-confirm__facts">
          <dt>{t("studio.dl.confirm.dest")}</dt>
          <dd class="studio-dl-confirm__dest">
            <code>{req.outputDir}</code>
            <button
              type="button"
              class="ghost-btn ghost-btn--sm"
              onclick={() => downloadFlow.settle(req.id, "pickDest")}
            >
              {t("studio.dl.confirm.changeDest")}
            </button>
          </dd>
          {#if req.count !== "none"}
            <dt>{t("studio.dl.confirm.tracks")}</dt>
            <dd class="studio-dl-confirm__count" aria-live="polite">
              {#if req.count === "counting"}
                <span class="studio-spinner studio-spinner--sm" aria-hidden="true"></span>
                <span class="studio-dl-confirm__muted">{t("studio.dl.confirm.counting")}</span>
              {:else if req.count === "known" && req.trackCount != null}
                {tp("studio.dl.tracksShort", req.trackCount)}
              {:else}
                <span class="studio-dl-confirm__muted">{t("studio.dl.tracksUnknown")}</span>
              {/if}
            </dd>
          {/if}
        </dl>
        <p class="studio-dl-confirm__msg">
          {req.artistFolderTarget
            ? t("studio.dl.confirmArtistFolder", { path: req.outputDir })
            : t("studio.dl.confirmAlbumFolder", { path: req.outputDir })}
        </p>
        {#if inLibrary}
          <p class="studio-dl-confirm__warn" role="note">
            {inLibrary.kind === "album"
              ? t("studio.dl.confirm.inLibraryAlbum", { folder: inLibrary.folder || req.ask.title })
              : t("studio.dl.confirm.inLibrarySong")}
          </p>
        {/if}
      {/if}

      {#snippet footer()}
        <Button
          variant="ghost"
          data-autofocus={danger || req.destIssue ? "" : undefined}
          onclick={() => downloadFlow.settle(req.id, "cancel")}
        >
          {inLibrary && !req.destIssue ? t("studio.dl.confirm.skip") : t("ui.confirm.cancel")}
        </Button>
        {#if req.destIssue}
          <Button variant="primary" onclick={() => downloadFlow.settle(req.id, "pickDest")}>
            {t("studio.dl.confirm.pickDest")}
          </Button>
        {:else}
          <Button
            variant="primary"
            tone={danger ? "danger" : "default"}
            data-autofocus={danger ? undefined : ""}
            onclick={() => downloadFlow.settle(req.id, "download")}
          >
            {inLibrary ? t("studio.dl.confirm.downloadAnyway") : t("ui.studioDownload.confirmOk")}
          </Button>
        {/if}
      {/snippet}
    </Modal>
  {/key}
{/if}

<style>
  .studio-dl-confirm__item {
    display: flex;
    align-items: center;
    gap: var(--rk-space-md);
    min-width: 0;
    margin-bottom: var(--rk-space-md);
  }

  .studio-dl-confirm__art {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: var(--rk-radius);
    overflow: hidden;
    background: color-mix(in srgb, var(--rk-ink) 8%, transparent);
    color: var(--rk-muted);
  }

  .studio-dl-confirm__art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .studio-dl-confirm__text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    gap: 2px;
  }

  .studio-dl-confirm__title {
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .studio-dl-confirm__meta,
  .studio-dl-confirm__muted {
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
  }

  .studio-dl-confirm__facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--rk-space-xs) var(--rk-space-md);
    margin: 0 0 var(--rk-space-sm);
    font-size: var(--rk-fs-sm);
  }

  .studio-dl-confirm__facts dt {
    color: var(--rk-muted);
  }

  .studio-dl-confirm__facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .studio-dl-confirm__dest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--rk-space-xs) var(--rk-space-sm);
  }

  .studio-dl-confirm__count {
    display: inline-flex;
    align-items: center;
    gap: var(--rk-space-xs);
  }

  .studio-dl-confirm__msg {
    margin: 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh-snug, 1.4);
    white-space: pre-line;
  }

  .studio-dl-confirm__warn {
    margin: var(--rk-space-sm) 0 0;
    padding: var(--rk-space-sm) var(--rk-space-md);
    border-radius: var(--rk-radius);
    border: 1px solid color-mix(in srgb, var(--rk-warning) 45%, var(--rk-line));
    background: color-mix(in srgb, var(--rk-warning) 10%, transparent);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh-snug, 1.4);
  }
</style>
