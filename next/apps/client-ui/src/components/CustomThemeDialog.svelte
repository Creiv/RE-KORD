<script lang="ts">
  import { Modal, Button, ActionRow, Field, Select } from "@rekord/ui";
  import { api } from "../lib/api";
  import {
    CUSTOM_THEME_BG_IMAGE_FITS,
    customThemeBgImageCss,
    objectFitForBgImageFit,
  } from "../lib/customThemeBgFit";
  import { customThemeBgImageUrl } from "../lib/customThemeBgUrl";
  import { extractThemeColorsFromImageUrl } from "../lib/extractThemeColorsFromImage";
  import { t } from "../lib/i18n.svelte";
  import {
    DEFAULT_CUSTOM_THEME,
    normalizeCustomTheme,
    type CustomThemeBgImageFit,
    type CustomThemeBgMode,
    type CustomThemeSettings,
  } from "../lib/themeCatalog";
  import {
    THEME_BG_MAX_MB,
    themeBgAcceptAttribute,
    validateThemeBgFile,
  } from "../lib/themeBgFile";

  let {
    open = false,
    theme = DEFAULT_CUSTOM_THEME,
    onclose,
    onsave,
  }: {
    open?: boolean;
    theme?: CustomThemeSettings;
    onclose: () => void;
    onsave: (theme: CustomThemeSettings) => void;
  } = $props();

  let draft = $state(normalizeCustomTheme(theme));
  let fileInput: HTMLInputElement | undefined = $state();
  let bgBusy = $state(false);
  let bgError = $state<string | null>(null);
  let paletteBusy = $state(false);
  let paletteErr = $state<string | null>(null);

  const bgMode = $derived<CustomThemeBgMode>(
    draft.bgMode === "image" ? "image" : "color",
  );
  const storedBgImageUrl = $derived(
    draft.bgImage ? customThemeBgImageUrl(draft.bgImageRev ?? undefined) : null,
  );
  const bgPreviewUrl = $derived(bgMode === "image" ? storedBgImageUrl : null);
  const fitOptions = $derived(
    CUSTOM_THEME_BG_IMAGE_FITS.map((fit) => ({
      value: fit,
      label: t(`themePicker.customBgFit.${fit}`),
    })),
  );

  $effect(() => {
    if (open) {
      draft = normalizeCustomTheme(theme);
      bgError = null;
      paletteErr = null;
      bgBusy = false;
      paletteBusy = false;
    }
  });

  function patchDraft(patch: Partial<CustomThemeSettings>) {
    draft = normalizeCustomTheme({ ...draft, ...patch });
  }

  async function onFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f || bgBusy) return;
    const validation = validateThemeBgFile(f);
    if (validation === "type") {
      bgError = t("themePicker.customBgTypeErr");
      return;
    }
    if (validation === "size") {
      bgError = t("themePicker.customBgSizeErr", { maxMb: THEME_BG_MAX_MB });
      return;
    }
    bgError = null;
    bgBusy = true;
    try {
      const { bgImage, bgImageRev } = await api.uploadCustomThemeBg(f);
      paletteErr = null;
      patchDraft({ bgMode: "image", bgImage, bgImageRev });
    } catch (e) {
      bgError = e instanceof Error ? e.message : String(e);
    } finally {
      bgBusy = false;
    }
  }

  async function onClearImage() {
    if (bgBusy) return;
    bgBusy = true;
    bgError = null;
    try {
      await api.clearCustomThemeBg();
      const { bgImage: _b, bgImageRev: _r, ...rest } = draft;
      void _b;
      void _r;
      paletteErr = null;
      draft = normalizeCustomTheme({ ...rest, bgMode: "color" });
    } catch (e) {
      bgError = e instanceof Error ? e.message : String(e);
    } finally {
      bgBusy = false;
    }
  }

  async function onExtractPalette() {
    if (!storedBgImageUrl || bgBusy || paletteBusy) return;
    paletteBusy = true;
    paletteErr = null;
    try {
      const colors = await extractThemeColorsFromImageUrl(storedBgImageUrl);
      patchDraft(colors);
    } catch {
      paletteErr = t("themePicker.customBgExtractErr");
    } finally {
      paletteBusy = false;
    }
  }

  function save() {
    onsave(normalizeCustomTheme(draft));
    onclose();
  }
</script>

{#snippet bgPreview(url: string, fit: CustomThemeBgImageFit | undefined, ext: string | null | undefined, className: string)}
  {@const fitCss = customThemeBgImageCss(fit)}
  {@const obj = objectFitForBgImageFit(fit)}
  {#if ext === "gif"}
    <img
      class={className}
      src={url}
      alt=""
      aria-hidden="true"
      style:background-color={draft.bg}
      style:object-fit={obj.objectFit}
      style:object-position={obj.objectPosition}
    />
  {:else}
    <span
      class={className}
      style:background-color={draft.bg}
      style:background-image={`url("${url}")`}
      style:background-size={fitCss.size}
      style:background-position={fitCss.position}
      style:background-repeat={fitCss.repeat}
    ></span>
  {/if}
{/snippet}

<Modal {open} title={t("themePicker.customDialogTitle")} {onclose}>
  <div class="custom-theme-dialog__preview" aria-hidden="true">
    {#if bgPreviewUrl}
      {@render bgPreview(bgPreviewUrl, draft.bgImageFit, draft.bgImage, "custom-theme-dialog__preview-bg")}
    {:else}
      <span style:background={draft.bg}></span>
    {/if}
    <span style:background={draft.section}></span>
    <span style:background={draft.accent}></span>
    <span style:background={draft.accent2}></span>
  </div>

  <div class="custom-theme-dialog__section">
    <span class="custom-theme-dialog__section-label">{t("themePicker.custom.bg")}</span>
    <div
      class="custom-theme-dialog__bg-mode"
      role="group"
      aria-label={t("themePicker.customBgModeAria")}
    >
      <button
        type="button"
        class="custom-theme-dialog__bg-mode-opt"
        class:is-active={bgMode === "color"}
        aria-pressed={bgMode === "color"}
        onclick={() => patchDraft({ bgMode: "color" })}
      >
        <span
          class="custom-theme-dialog__bg-mode-swatch"
          style:background={draft.bg}
          aria-hidden="true"
        ></span>
        <span>{t("themePicker.customBgColor")}</span>
      </button>
      <button
        type="button"
        class="custom-theme-dialog__bg-mode-opt"
        class:is-active={bgMode === "image"}
        aria-pressed={bgMode === "image"}
        onclick={() => patchDraft({ bgMode: "image" })}
      >
        <span
          class="custom-theme-dialog__bg-mode-swatch custom-theme-dialog__bg-mode-swatch--image"
          class:has-image={Boolean(storedBgImageUrl)}
          aria-hidden="true"
        >
          {#if storedBgImageUrl}
            {@render bgPreview(
              storedBgImageUrl,
              draft.bgImageFit,
              draft.bgImage,
              "custom-theme-dialog__bg-mode-swatch-fill",
            )}
          {/if}
        </span>
        <span>{t("themePicker.customBgImage")}</span>
      </button>
    </div>
  </div>

  {#if bgMode === "color"}
    <div class="custom-theme-dialog__section">
      <Field label={t("themePicker.custom.bg")}>
        <input class="custom-theme-dialog__color" type="color" bind:value={draft.bg} />
      </Field>
    </div>
  {:else}
    <div class="custom-theme-dialog__section">
      <div class="custom-theme-dialog__image-panel">
        <button
          type="button"
          class="custom-theme-dialog__image-drop"
          disabled={bgBusy}
          onclick={() => fileInput?.click()}
        >
          {#if bgPreviewUrl}
            {@render bgPreview(
              bgPreviewUrl,
              draft.bgImageFit,
              draft.bgImage,
              "custom-theme-dialog__image-preview",
            )}
          {:else}
            <span class="custom-theme-dialog__image-placeholder">
              {t("themePicker.customBgDropHint")}
            </span>
          {/if}
          <span class="custom-theme-dialog__image-cta">
            {bgBusy
              ? t("settings.saving")
              : draft.bgImage
                ? t("themePicker.customBgChange")
                : t("themePicker.customBgChoose")}
          </span>
        </button>
        <div class="custom-theme-dialog__image-toolbar">
          {#if draft.bgImage}
            <div class="custom-theme-dialog__image-actions">
              <Button
                variant="ghost"
                disabled={bgBusy || paletteBusy}
                onclick={() => void onExtractPalette()}
              >
                {paletteBusy
                  ? t("themePicker.customBgExtractBusy")
                  : t("themePicker.customBgExtract")}
              </Button>
              <Button
                variant="ghost"
                disabled={bgBusy || paletteBusy}
                onclick={() => void onClearImage()}
              >
                {t("themePicker.customBgClear")}
              </Button>
            </div>
          {:else}
            <span class="custom-theme-dialog__image-toolbar-spacer" aria-hidden="true"></span>
          {/if}
          <label class="custom-theme-dialog__fit-control">
            <span class="custom-theme-dialog__fit-label">
              {t("themePicker.customBgFitLabel")}
            </span>
            <Select
              options={fitOptions}
              value={draft.bgImageFit ?? "cover"}
              disabled={bgBusy}
              aria-label={t("themePicker.customBgFitAria")}
              onchange={(event) =>
                patchDraft({
                  bgImageFit: (event.currentTarget as HTMLSelectElement)
                    .value as CustomThemeBgImageFit,
                })}
            />
          </label>
        </div>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        accept={themeBgAcceptAttribute()}
        class="sr-only"
        onchange={(event) => void onFileChange(event)}
      />
    </div>
  {/if}

  {#if bgError}
    <p class="custom-theme-dialog__err">{bgError}</p>
  {/if}
  {#if paletteErr}
    <p class="custom-theme-dialog__err">{paletteErr}</p>
  {/if}

  <p class="custom-theme-dialog__lede">{t("themePicker.customColorsHeading")}</p>
  <div class="custom-theme-dialog__grid">
    {#if draft.bgImage}
      <Field label={t("themePicker.custom.bg")}>
        <input class="custom-theme-dialog__color" type="color" bind:value={draft.bg} />
      </Field>
    {/if}
    <Field label={t("themePicker.custom.section")}>
      <input
        class="custom-theme-dialog__color"
        type="color"
        bind:value={draft.section}
      />
    </Field>
    <Field label={t("themePicker.custom.accent")}>
      <input
        class="custom-theme-dialog__color"
        type="color"
        bind:value={draft.accent}
      />
    </Field>
    <Field label={t("themePicker.custom.accent2")}>
      <input
        class="custom-theme-dialog__color"
        type="color"
        bind:value={draft.accent2}
      />
    </Field>
  </div>

  {#snippet footer()}
    <ActionRow>
      <Button variant="ghost" onclick={onclose}>{t("common.cancel")}</Button>
      <Button onclick={save} disabled={bgBusy}>{t("common.save")}</Button>
    </ActionRow>
  {/snippet}
</Modal>

<style>
  .custom-theme-dialog__lede {
    margin: 0.85rem 0 0.75rem;
    color: var(--rk-muted);
    font-size: 0.88rem;
  }

  .custom-theme-dialog__preview {
    display: flex;
    height: 14px;
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 1rem;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rk-ink) 16%, transparent);
  }

  .custom-theme-dialog__preview > :global(*),
  .custom-theme-dialog__preview span {
    flex: 1;
    min-width: 0;
  }

  .custom-theme-dialog__preview-bg {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .custom-theme-dialog__section {
    margin-bottom: 0.85rem;
  }

  .custom-theme-dialog__section-label {
    display: block;
    margin-bottom: 0.45rem;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--rk-muted-strong);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .custom-theme-dialog__bg-mode {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.55rem;
  }

  .custom-theme-dialog__bg-mode-opt {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-height: 2.6rem;
    padding: 0.45rem 0.65rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    color: var(--rk-ink);
    font: inherit;
    font-size: 0.88rem;
    cursor: pointer;
    text-align: left;
  }

  .custom-theme-dialog__bg-mode-opt.is-active {
    border-color: color-mix(in srgb, var(--rk-accent) 42%, var(--rk-line));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rk-accent) 28%, transparent);
  }

  .custom-theme-dialog__bg-mode-swatch {
    width: 1.55rem;
    height: 1.55rem;
    border-radius: 0.4rem;
    flex-shrink: 0;
    overflow: hidden;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rk-ink) 14%, transparent);
    position: relative;
  }

  .custom-theme-dialog__bg-mode-swatch--image:not(.has-image) {
    background: repeating-linear-gradient(
      -45deg,
      color-mix(in srgb, var(--rk-ink) 12%, transparent),
      color-mix(in srgb, var(--rk-ink) 12%, transparent) 4px,
      transparent 4px,
      transparent 8px
    );
  }

  .custom-theme-dialog__bg-mode-swatch-fill {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .custom-theme-dialog__image-panel {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .custom-theme-dialog__image-drop {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    min-height: 7.5rem;
    border-radius: var(--rk-radius-lg);
    border: 1px dashed color-mix(in srgb, var(--rk-ink) 22%, transparent);
    background: color-mix(in srgb, var(--rk-surface-3) 86%, transparent);
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    color: var(--rk-ink);
    font: inherit;
  }

  .custom-theme-dialog__image-drop:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .custom-theme-dialog__image-preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .custom-theme-dialog__image-placeholder {
    padding: 1.2rem;
    color: var(--rk-muted);
    font-size: 0.9rem;
  }

  .custom-theme-dialog__image-cta {
    position: relative;
    z-index: 1;
    margin: 0.55rem;
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--rk-surface-2) 88%, transparent);
    border: 1px solid var(--rk-line);
    font-size: 0.82rem;
    font-weight: 650;
  }

  .custom-theme-dialog__image-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.65rem;
  }

  .custom-theme-dialog__image-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .custom-theme-dialog__image-toolbar-spacer {
    flex: 1;
  }

  .custom-theme-dialog__fit-control {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: min(12rem, 100%);
  }

  .custom-theme-dialog__fit-label {
    font-size: 0.78rem;
    font-weight: 650;
    color: var(--rk-muted-strong);
  }

  .custom-theme-dialog__err {
    margin: 0 0 0.65rem;
    color: color-mix(in srgb, #f87171 70%, var(--rk-ink));
    font-size: 0.85rem;
  }

  .custom-theme-dialog__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem 1rem;
  }

  .custom-theme-dialog__color {
    width: 100%;
    height: 2.25rem;
    padding: 0.2rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    cursor: pointer;
  }

  @media (max-width: 520px) {
    .custom-theme-dialog__grid,
    .custom-theme-dialog__bg-mode {
      grid-template-columns: 1fr;
    }
  }
</style>
