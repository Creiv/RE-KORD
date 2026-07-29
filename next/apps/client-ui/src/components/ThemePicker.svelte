<script lang="ts">
  import { onMount } from "svelte";
  import {
    customThemeBgImageCss,
    objectFitForBgImageFit,
  } from "../lib/customThemeBgFit";
  import { customThemeBgImageUrl } from "../lib/customThemeBgUrl";
  import { t } from "../lib/i18n.svelte";
  import {
    THEME_CATALOG,
    THEME_GROUPS,
    catalogEntry,
    type CustomThemeBgImageFit,
    type CustomThemeSettings,
  } from "../lib/themeCatalog";
  import type { UiTheme } from "../lib/userPrefs";
  import CustomThemeDialog from "./CustomThemeDialog.svelte";

  let {
    value,
    customTheme,
    onchange,
    onCustomThemeChange,
    ariaLabel = "",
    showCustomizeButton = true,
    customizeOpen = undefined,
    onCustomizeOpenChange = undefined,
  }: {
    value: UiTheme;
    customTheme: CustomThemeSettings;
    onchange: (theme: UiTheme) => void;
    onCustomThemeChange: (theme: CustomThemeSettings) => void;
    ariaLabel?: string;
    showCustomizeButton?: boolean;
    customizeOpen?: boolean;
    onCustomizeOpenChange?: (open: boolean) => void;
  } = $props();

  let open = $state(false);
  let internalCustomOpen = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();

  const customOpen = $derived(customizeOpen ?? internalCustomOpen);
  function setCustomOpen(next: boolean) {
    if (onCustomizeOpenChange) onCustomizeOpenChange(next);
    else internalCustomOpen = next;
  }

  const current = $derived.by(() => {
    const base = catalogEntry(value);
    return value === "custom" ? { ...base, ...customTheme } : base;
  });

  const currentLabel = $derived(
    value === "midnight"
      ? `${t(`theme.${value}`)} (${t("settings.themeDefault")})`
      : t(`theme.${value}`),
  );

  const customBgPreviewUrl = $derived(
    customTheme.bgMode === "image" && customTheme.bgImage
      ? customThemeBgImageUrl(customTheme.bgImageRev ?? undefined)
      : null,
  );

  function pick(id: string) {
    onchange(id as UiTheme);
    open = false;
    if (id === "custom") setCustomOpen(true);
  }

  function onDocPointer(e: PointerEvent) {
    if (!open || !rootEl) return;
    if (!rootEl.contains(e.target as Node)) open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) open = false;
  }

  onMount(() => {
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

{#snippet themeStrip(
  bg: string,
  section: string,
  accent: string,
  accent2: string,
  bgImageUrl: string | null = null,
  bgImageFit: CustomThemeBgImageFit | undefined = undefined,
  bgImageExt: string | null | undefined = undefined,
)}
  {@const fitCss = customThemeBgImageCss(bgImageFit)}
  {@const obj = objectFitForBgImageFit(bgImageFit)}
  <span class="theme-picker__strip" aria-hidden="true">
    {#if bgImageExt === "gif" && bgImageUrl}
      <img
        class="theme-picker__strip-seg theme-picker__strip-seg--bg"
        src={bgImageUrl}
        alt=""
        style:background-color={bg}
        style:object-fit={obj.objectFit}
        style:object-position={obj.objectPosition}
        title={t("themePicker.stripBg")}
      />
    {:else if bgImageUrl}
      <span
        class="theme-picker__strip-seg theme-picker__strip-seg--bg"
        style:background-color={bg}
        style:background-image={`url("${bgImageUrl}")`}
        style:background-size={fitCss.size}
        style:background-position={fitCss.position}
        style:background-repeat={fitCss.repeat}
        title={t("themePicker.stripBg")}
      ></span>
    {:else}
      <span
        class="theme-picker__strip-seg theme-picker__strip-seg--bg"
        style:background={bg}
        title={t("themePicker.stripBg")}
      ></span>
    {/if}
    <span
      class="theme-picker__strip-seg"
      style:background={section}
      title={t("themePicker.stripSection")}
    ></span>
    <span
      class="theme-picker__strip-seg"
      style:background={accent}
      title={t("themePicker.stripAccent1")}
    ></span>
    <span
      class="theme-picker__strip-seg"
      style:background={accent2}
      title={t("themePicker.stripAccent2")}
    ></span>
  </span>
{/snippet}

<div class="theme-picker" class:is-open={open} bind:this={rootEl}>
  <button
    type="button"
    class="theme-picker__btn"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel || t("settings.themeAria")}
    onclick={() => (open = !open)}
  >
    <span class="theme-picker__label">{currentLabel}</span>
    {@render themeStrip(
      current.bg,
      current.section,
      current.accent,
      current.accent2,
      value === "custom" ? customBgPreviewUrl : null,
      value === "custom" ? customTheme.bgImageFit : undefined,
      value === "custom" ? customTheme.bgImage : undefined,
    )}
  </button>

  {#if open}
    <ul class="theme-picker__menu" role="listbox">
      {#each THEME_GROUPS as group (group.id)}
        {@const entries = THEME_CATALOG.filter((e) => e.group === group.id)}
        {#if entries.length}
          <li class="theme-picker__group" role="none">
            <div class="theme-picker__group-label">{t(group.labelKey)}</div>
            <ul class="theme-picker__group-list" role="none">
              {#each entries as entry (entry.id)}
                {@const preview =
                  entry.id === "custom" ? { ...entry, ...customTheme } : entry}
                {@const label =
                  entry.id === "midnight"
                    ? `${t(`theme.${entry.id}`)} (${t("settings.themeDefault")})`
                    : t(`theme.${entry.id}`)}
                <li role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={entry.id === value}
                    class="theme-picker__opt"
                    class:is-active={entry.id === value}
                    onclick={() => pick(entry.id)}
                  >
                    <span class="theme-picker__name">{label}</span>
                    {@render themeStrip(
                      preview.bg,
                      preview.section,
                      preview.accent,
                      preview.accent2,
                      entry.id === "custom" &&
                        customTheme.bgMode === "image" &&
                        customTheme.bgImage
                        ? customBgPreviewUrl
                        : null,
                      entry.id === "custom" ? customTheme.bgImageFit : undefined,
                      entry.id === "custom" ? customTheme.bgImage : undefined,
                    )}
                  </button>
                </li>
              {/each}
            </ul>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  {#if value === "custom" && showCustomizeButton}
    <button
      type="button"
      class="theme-picker__customize-btn"
      onclick={() => setCustomOpen(true)}
    >
      {t("themePicker.customEditBtn")}
    </button>
  {/if}
</div>

<CustomThemeDialog
  open={customOpen}
  theme={customTheme}
  onclose={() => setCustomOpen(false)}
  onchange={onCustomThemeChange}
/>
