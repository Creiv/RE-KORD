<script lang="ts">
  import { Button } from "@rekord/ui";
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
    onchange,
  }: {
    open?: boolean;
    theme?: CustomThemeSettings;
    onclose: () => void;
    /** Live apply (legacy parity) — page updates behind the transparent overlay. */
    onchange: (theme: CustomThemeSettings) => void;
  } = $props();

  let panelEl: HTMLDivElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let bgBusy = $state(false);
  let bgError = $state<string | null>(null);
  let paletteBusy = $state(false);
  let paletteErr = $state<string | null>(null);

  const bgMode = $derived<CustomThemeBgMode>(
    theme.bgMode === "image" ? "image" : "color",
  );
  const storedBgImageUrl = $derived(
    theme.bgImage ? customThemeBgImageUrl(theme.bgImageRev ?? undefined) : null,
  );
  const bgPreviewUrl = $derived(bgMode === "image" ? storedBgImageUrl : null);
  const colorKeys = $derived(
    theme.bgImage
      ? (["bg", "section", "accent", "accent2"] as const)
      : (["section", "accent", "accent2"] as const),
  );

  /** Escape stacking contexts (glass panels / settings cards) — legacy createPortal. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }

  $effect(() => {
    if (!open) return;
    bgError = null;
    paletteErr = null;
    bgBusy = false;
    paletteBusy = false;
    queueMicrotask(() => panelEl?.focus());
  });

  function patch(patch: Partial<CustomThemeSettings>) {
    onchange(normalizeCustomTheme({ ...theme, ...patch }));
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
      onchange(
        normalizeCustomTheme({
          ...theme,
          bgMode: "image",
          bgImage,
          bgImageRev,
        }),
      );
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
      const { bgImage: _b, bgImageRev: _r, ...rest } = theme;
      void _b;
      void _r;
      paletteErr = null;
      onchange(normalizeCustomTheme({ ...rest, bgMode: "color" }));
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
      onchange(normalizeCustomTheme({ ...theme, ...colors }));
    } catch {
      paletteErr = t("themePicker.customBgExtractErr");
    } finally {
      paletteBusy = false;
    }
  }

  function onBackdropPointer(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onclose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#snippet bgPreview(
  url: string,
  fit: CustomThemeBgImageFit | undefined,
  ext: string | null | undefined,
  className: string,
)}
  {@const fitCss = customThemeBgImageCss(fit)}
  {@const obj = objectFitForBgImageFit(fit)}
  {#if ext === "gif"}
    <img
      class={className}
      src={url}
      alt=""
      aria-hidden="true"
      style:background-color={theme.bg}
      style:object-fit={obj.objectFit}
      style:object-position={obj.objectPosition}
    />
  {:else}
    <span
      class={className}
      style:background-color={theme.bg}
      style:background-image={`url("${url}")`}
      style:background-size={fitCss.size}
      style:background-position={fitCss.position}
      style:background-repeat={fitCss.repeat}
    ></span>
  {/if}
{/snippet}

{#if open}
  <!-- Transparent overlay (legacy custom-theme-dialog-backdrop) — no dim/blur. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="custom-theme-dialog-backdrop"
    role="presentation"
    use:portal
    onmousedown={onBackdropPointer}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={panelEl}
      class="custom-theme-dialog rk-scroll"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-theme-dialog-title"
      tabindex="-1"
      onmousedown={(e) => e.stopPropagation()}
    >
      <header class="custom-theme-dialog__head">
        <div class="custom-theme-dialog__titles">
          <p class="custom-theme-dialog__eyebrow">{t("settings.panel.ui")}</p>
          <h2 id="custom-theme-dialog-title" class="custom-theme-dialog__title">
            {t("themePicker.customDialogTitle")}
          </h2>
        </div>
        <button
          type="button"
          class="custom-theme-dialog__close"
          onclick={onclose}
          aria-label={t("nav.close")}
          title={t("nav.close")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
      </header>

      <div class="custom-theme-dialog__body">
        <div class="custom-theme-dialog__preview-strip" aria-hidden="true">
          {#if bgPreviewUrl}
            {@render bgPreview(
              bgPreviewUrl,
              theme.bgImageFit,
              theme.bgImage,
              "custom-theme-dialog__preview-strip-seg custom-theme-dialog__preview-strip-seg--bg",
            )}
          {:else}
            <span
              class="custom-theme-dialog__preview-strip-seg custom-theme-dialog__preview-strip-seg--bg"
              style:background={theme.bg}
            ></span>
          {/if}
          <span
            class="custom-theme-dialog__preview-strip-seg"
            style:background={theme.section}
          ></span>
          <span
            class="custom-theme-dialog__preview-strip-seg"
            style:background={theme.accent}
          ></span>
          <span
            class="custom-theme-dialog__preview-strip-seg"
            style:background={theme.accent2}
          ></span>
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
              onclick={() => patch({ bgMode: "color" })}
            >
              <span
                class="custom-theme-dialog__bg-mode-swatch"
                style:background={theme.bg}
                aria-hidden="true"
              ></span>
              <span>{t("themePicker.customBgColor")}</span>
            </button>
            <button
              type="button"
              class="custom-theme-dialog__bg-mode-opt"
              class:is-active={bgMode === "image"}
              aria-pressed={bgMode === "image"}
              onclick={() => patch({ bgMode: "image" })}
            >
              <span
                class="custom-theme-dialog__bg-mode-swatch custom-theme-dialog__bg-mode-swatch--image"
                class:has-image={Boolean(storedBgImageUrl)}
                aria-hidden="true"
              >
                {#if storedBgImageUrl}
                  {@render bgPreview(
                    storedBgImageUrl,
                    theme.bgImageFit,
                    theme.bgImage,
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
            <button
              type="button"
              class="custom-theme-dialog__swatch"
              onclick={(e) =>
                (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.click()}
              aria-label={t("themePicker.custom.bg")}
            >
              <span
                class="custom-theme-dialog__swatch-chip"
                style:background={theme.bg}
                aria-hidden="true"
              ></span>
              <span class="custom-theme-dialog__swatch-label"
                >{t("themePicker.custom.bg")}</span
              >
              <span class="custom-theme-dialog__swatch-hex" aria-hidden="true"
                >{theme.bg.toUpperCase()}</span
              >
              <input
                class="custom-theme-dialog__swatch-input"
                type="color"
                value={theme.bg}
                tabindex={-1}
                aria-hidden="true"
                oninput={(e) =>
                  patch({ bg: (e.currentTarget as HTMLInputElement).value })}
              />
            </button>
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
                    theme.bgImageFit,
                    theme.bgImage,
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
                    : theme.bgImage
                      ? t("themePicker.customBgChange")
                      : t("themePicker.customBgChoose")}
                </span>
              </button>
              <div class="custom-theme-dialog__image-toolbar">
                {#if theme.bgImage}
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
                  <span
                    class="custom-theme-dialog__image-toolbar-spacer"
                    aria-hidden="true"
                  ></span>
                {/if}
                <label class="custom-theme-dialog__fit-control">
                  <span class="custom-theme-dialog__fit-label">
                    {t("themePicker.customBgFitLabel")}
                  </span>
                  <select
                    class="custom-theme-dialog__fit-select"
                    value={theme.bgImageFit ?? "cover"}
                    disabled={bgBusy}
                    aria-label={t("themePicker.customBgFitAria")}
                    onchange={(e) =>
                      patch({
                        bgImageFit: (e.currentTarget as HTMLSelectElement)
                          .value as CustomThemeBgImageFit,
                      })}
                  >
                    {#each CUSTOM_THEME_BG_IMAGE_FITS as fit (fit)}
                      <option value={fit}>{t(`themePicker.customBgFit.${fit}`)}</option>
                    {/each}
                  </select>
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

        <div class="custom-theme-dialog__section">
          <span class="custom-theme-dialog__section-label">
            {t("themePicker.customColorsHeading")}
          </span>
          <div
            class="custom-theme-dialog__swatch-grid"
            class:custom-theme-dialog__swatch-grid--4={colorKeys.length === 4}
          >
            {#each colorKeys as key (key)}
              <button
                type="button"
                class="custom-theme-dialog__swatch"
                onclick={(e) =>
                  (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.click()}
                aria-label={t(`themePicker.custom.${key}`)}
              >
                <span
                  class="custom-theme-dialog__swatch-chip"
                  style:background={theme[key]}
                  aria-hidden="true"
                ></span>
                <span class="custom-theme-dialog__swatch-label"
                  >{t(`themePicker.custom.${key}`)}</span
                >
                <span class="custom-theme-dialog__swatch-hex" aria-hidden="true"
                  >{theme[key].toUpperCase()}</span
                >
                <input
                  class="custom-theme-dialog__swatch-input"
                  type="color"
                  value={theme[key]}
                  tabindex={-1}
                  aria-hidden="true"
                  oninput={(e) =>
                    patch({
                      [key]: (e.currentTarget as HTMLInputElement).value,
                    } as Partial<CustomThemeSettings>)}
                />
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Modal-aligned chrome; backdrop stays transparent (live preview behind). */
  .custom-theme-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--rk-z-modal, 120);
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    display: grid;
    place-items: center;
    padding: 1rem;
    box-sizing: border-box;
  }

  .custom-theme-dialog {
    width: min(28rem, 100%);
    max-height: min(90dvh, 900px);
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--rk-surface);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    box-shadow: var(--rk-shadow);
    color: var(--rk-ink);
    outline: none;
  }

  .custom-theme-dialog__head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    padding: 0.7rem 0.85rem 0.55rem;
    border-bottom: 1px solid var(--rk-line);
  }

  .custom-theme-dialog__titles {
    min-width: 0;
  }

  .custom-theme-dialog__eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.68rem;
    color: var(--rk-muted);
    font-weight: 650;
  }

  .custom-theme-dialog__title {
    margin: 0.15rem 0 0;
    font-size: 1.05rem;
    font-weight: 700;
    line-height: 1.25;
  }

  .custom-theme-dialog__close {
    flex: 0 0 auto;
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--rk-muted);
    cursor: pointer;
    padding: 0;
    border-radius: var(--rk-radius-sm);
  }

  .custom-theme-dialog__close:hover {
    color: var(--rk-ink);
    background: var(--rk-surface-3);
  }

  .custom-theme-dialog__body {
    padding: 0.7rem 0.85rem;
    display: grid;
    gap: 0.7rem;
  }

  .custom-theme-dialog__preview-strip {
    display: flex;
    height: 2.35rem;
    border-radius: var(--rk-radius);
    overflow: hidden;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--rk-ink) 14%, transparent),
      inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }

  .custom-theme-dialog__preview-strip-seg {
    flex: 1;
    min-width: 0;
  }

  .custom-theme-dialog__preview-strip-seg--bg {
    flex: 1.35;
    display: block;
    background-repeat: no-repeat;
    object-fit: cover;
  }

  .custom-theme-dialog__section {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
  }

  .custom-theme-dialog__section-label {
    color: var(--rk-muted-strong);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .custom-theme-dialog__bg-mode {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.45rem;
  }

  .custom-theme-dialog__bg-mode-opt {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.45rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    color: var(--rk-ink);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 650;
  }

  .custom-theme-dialog__bg-mode-opt:hover {
    border-color: var(--rk-line-strong);
  }

  .custom-theme-dialog__bg-mode-opt.is-active {
    border-color: color-mix(in srgb, var(--rk-accent) 55%, var(--rk-line) 45%);
    background: color-mix(in srgb, var(--rk-accent) 10%, var(--rk-surface-3) 90%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rk-accent) 22%, transparent);
  }

  .custom-theme-dialog__bg-mode-swatch {
    width: 100%;
    height: 2.1rem;
    border-radius: var(--rk-radius-sm);
    border: 1px solid color-mix(in srgb, var(--rk-ink) 12%, transparent);
  }

  .custom-theme-dialog__bg-mode-swatch--image {
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--rk-muted) 18%, transparent) 0 4px,
      transparent 4px 8px
    );
  }

  .custom-theme-dialog__bg-mode-swatch--image.has-image {
    padding: 0;
    overflow: hidden;
    background: var(--rk-surface-2);
  }

  .custom-theme-dialog__bg-mode-swatch-fill {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
  }

  .custom-theme-dialog__image-panel {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .custom-theme-dialog__image-drop {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.45rem;
    width: 100%;
    padding: 0;
    border: 1px dashed color-mix(in srgb, var(--rk-line) 88%, var(--rk-accent) 12%);
    border-radius: var(--rk-radius);
    background: color-mix(in srgb, var(--rk-surface-3) 92%, transparent);
    color: var(--rk-ink);
    cursor: pointer;
    font: inherit;
    overflow: hidden;
  }

  .custom-theme-dialog__image-drop:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--rk-accent) 40%, var(--rk-line) 60%);
  }

  .custom-theme-dialog__image-drop:disabled {
    opacity: 0.65;
    cursor: wait;
  }

  .custom-theme-dialog__image-preview {
    display: block;
    width: 100%;
    height: 7.5rem;
    object-fit: cover;
    object-position: center;
  }

  .custom-theme-dialog__image-placeholder {
    display: grid;
    place-items: center;
    min-height: 7.5rem;
    padding: 1rem;
    color: var(--rk-muted);
    font-size: 0.88rem;
    text-align: center;
  }

  .custom-theme-dialog__image-cta {
    padding: 0.55rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--rk-line) 80%, transparent);
    font-size: 0.85rem;
    font-weight: 650;
    text-align: center;
  }

  .custom-theme-dialog__image-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    flex-wrap: wrap;
  }

  .custom-theme-dialog__image-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    min-width: 0;
  }

  .custom-theme-dialog__image-toolbar-spacer {
    flex: 0 0 auto;
  }

  .custom-theme-dialog__fit-control {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    margin-left: auto;
    font-size: 0.78rem;
    color: var(--rk-muted-strong);
  }

  .custom-theme-dialog__fit-label {
    font-weight: 600;
    white-space: nowrap;
  }

  .custom-theme-dialog__fit-select {
    min-width: 8.5rem;
    padding: 0.28rem 0.45rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--rk-ink);
    background: var(--rk-surface-3);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
  }

  .custom-theme-dialog__swatch-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.45rem;
  }

  .custom-theme-dialog__swatch-grid--4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .custom-theme-dialog__swatch {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
    padding: 0.55rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    color: var(--rk-ink);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .custom-theme-dialog__swatch:hover {
    border-color: var(--rk-line-strong);
  }

  .custom-theme-dialog__swatch-chip {
    display: block;
    width: 100%;
    height: 2.25rem;
    border-radius: var(--rk-radius-sm);
    border: 1px solid color-mix(in srgb, var(--rk-ink) 14%, transparent);
  }

  .custom-theme-dialog__swatch-label {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--rk-muted-strong);
  }

  .custom-theme-dialog__swatch-hex {
    font-size: 0.68rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--rk-muted);
  }

  .custom-theme-dialog__swatch-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .custom-theme-dialog__err {
    margin: 0;
    font-size: 0.84rem;
    color: var(--rk-danger, #e85d5d);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
