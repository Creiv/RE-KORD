<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Field, Panel, Select } from "@rekord/ui";
  import SettingsFieldsGrid from "../SettingsFieldsGrid.svelte";
  import ShortcutList from "../ShortcutList.svelte";
  import ThemePicker from "../ThemePicker.svelte";
  import LayoutWidthFields from "./LayoutWidthFields.svelte";
  import UiIcon from "../icons/UiIcon.svelte";
  import { api } from "../../lib/api";
  import { i18n, t } from "../../lib/i18n.svelte";
  import { prefsRevision } from "../../lib/prefsRevision.svelte";
  import { session } from "../../lib/session.svelte";
  import { shortcutItems } from "../../lib/shortcutList";
  import {
    ALL_VISUALIZER_MODES,
    applyTheme,
    loadUserPrefs,
    normalizeGlassOpacity,
    DEFAULT_GLASS_OPACITY,
    normalizeLocale,
    normalizeTheme,
    patchUserPrefs,
    syncGlassSurfaceDom,
    type CrossfadeSec,
    type CustomThemeSettings,
    type UiTheme,
    type VisualizerMode,
  } from "../../lib/userPrefs";

  import type { SettingsAccounts } from "./settingsAccounts.svelte";

  /** Theme import / export wait for a backup or restore running in System. */
  let { ctx }: { ctx: SettingsAccounts } = $props();
  const hubBusy = $derived(ctx.jobs.hubBusy);

  /** Settings › Interface › Features: the optional experiences, per account. */
  const FEATURE_SWITCHES = [
    { key: "featureNebula", labelKey: "settings.features.nebula" },
    { key: "featureVisualizer", labelKey: "settings.features.visualizer" },
    { key: "featurePlectr", labelKey: "settings.features.plectr" },
  ] as const;
  const featurePrefs = $derived.by(() => {
    void prefsRevision.any;
    const p = loadUserPrefs();
    return {
      featureNebula: p.featureNebula,
      featureVisualizer: p.featureVisualizer,
      featurePlectr: p.featurePlectr,
    };
  });

  const fadeOptions = $derived([
    { value: "0", label: t("settings.audioCrossfadeOff") },
    { value: "3", label: t("settings.audioCrossfade3") },
    { value: "5", label: t("settings.audioCrossfade5") },
  ]);

  const languageOptions = $derived([
    { value: "it", label: t("settings.langIt") },
    { value: "en", label: t("settings.langEn") },
    { value: "de", label: t("settings.langDe") },
  ]);

  const vizLabelKeys: Record<(typeof ALL_VISUALIZER_MODES)[number], string> = {
    bars: "settings.vizBars",
    mirror: "settings.vizMirror",
    osc: "settings.vizOsc",
    oscSoft: "settings.vizOscSoft",
    hmb: "settings.vizHmb",
    signals: "settings.vizSignals",
    karaoke: "settings.vizKaraoke",
    discowall: "viz.discowall",
  };

  const vizOptions = $derived(
    ALL_VISUALIZER_MODES.map((id) => ({
      value: id,
      label: t(vizLabelKeys[id]),
    })),
  );

  const shortcuts = $derived(shortcutItems(t));

  let fadeValue = $state(String(session.crossfadeSec));
  let localeValue = $state(i18n.locale);
  let themeValue = $state(loadUserPrefs().theme);
  let customThemeValue = $state(loadUserPrefs().customTheme);
  let glassSurfaces = $state(loadUserPrefs().glassSurfaces);
  let glassOpacityDraft = $state(loadUserPrefs().glassOpacity);
  /** The slider shows transparency (0% = most opaque); prefs keep the opacity. */
  const glassTransparency = $derived(100 - glassOpacityDraft);
  let glassOpacityTimer: ReturnType<typeof setTimeout> | null = null;
  let customThemeDialogOpen = $state(false);
  let vizValue = $state(loadUserPrefs().visualizerMode);

  let themeImportBusy = $state(false);
  let themeExportBusy = $state(false);
  let themeImportOk = $state("");
  let themeImportErr = $state("");
  let themeExportOk = $state("");
  let themeExportErr = $state("");
  let themeImportInput: HTMLInputElement | undefined = $state();

  function reloadFromPrefs() {
    const p = loadUserPrefs();
    themeValue = p.theme;
    customThemeValue = p.customTheme;
    glassSurfaces = p.glassSurfaces;
    glassOpacityDraft = p.glassOpacity;
    vizValue = p.visualizerMode;
    localeValue = i18n.locale;
  }

  // Another tab (or the account panel of another window) may rebind the
  // account while this panel is open: show that account's preferences.
  let boundAccount = session.activeAccountId;
  $effect(() => {
    const bound = session.activeAccountId;
    if (bound && bound !== boundAccount) {
      boundAccount = bound;
      untrack(reloadFromPrefs);
    }
  });

  // The hub (another device) or another tab changed this account's prefs:
  // show them, so touching the panel never pushes stale values back. Skipped
  // while an opacity drag is still being saved.
  $effect(() => {
    void prefsRevision.any;
    untrack(() => {
      if (!glassOpacityTimer) reloadFromPrefs();
    });
  });

  $effect(() => {
    fadeValue = String(session.crossfadeSec);
  });

  $effect(() => () => {
    if (glassOpacityTimer) clearTimeout(glassOpacityTimer);
  });

  function selectValue(ev: Event): string {
    return (ev.currentTarget as HTMLSelectElement).value;
  }

  function onVizChange(next: string) {
    if ((ALL_VISUALIZER_MODES as readonly string[]).includes(next)) {
      const mode = next as VisualizerMode;
      vizValue = mode;
      patchUserPrefs({ visualizerMode: mode });
    }
  }

  function onFadeChange(next: string) {
    fadeValue = next;
    const n = Number(next) as CrossfadeSec;
    if (n === 0 || n === 3 || n === 5) session.setCrossfade(n);
  }

  function onLocaleChange(next: string) {
    i18n.setLocale(normalizeLocale(next));
    localeValue = i18n.locale;
  }

  function onThemeChange(next: UiTheme) {
    const theme = normalizeTheme(next);
    themeValue = theme;
    patchUserPrefs({ theme });
    applyTheme(theme, customThemeValue, {
      glassSurfaces,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onCustomThemeChange(next: CustomThemeSettings) {
    customThemeValue = next;
    themeValue = "custom";
    patchUserPrefs({ theme: "custom", customTheme: next });
    applyTheme("custom", next, {
      glassSurfaces,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onGlassSurfacesChange(checked: boolean) {
    glassSurfaces = checked;
    // Switching glass on starts again from the default transparency (1%).
    if (checked) {
      if (glassOpacityTimer) clearTimeout(glassOpacityTimer);
      glassOpacityTimer = null;
      glassOpacityDraft = DEFAULT_GLASS_OPACITY;
    }
    patchUserPrefs({ glassSurfaces: checked, glassOpacity: glassOpacityDraft });
    syncGlassSurfaceDom(undefined, {
      glassSurfaces: checked,
      glassOpacity: glassOpacityDraft,
    });
  }

  function onGlassOpacityChange(raw: number) {
    const v = normalizeGlassOpacity(raw);
    glassOpacityDraft = v;
    if (glassOpacityTimer) clearTimeout(glassOpacityTimer);
    glassOpacityTimer = setTimeout(() => {
      glassOpacityTimer = null;
      patchUserPrefs({ glassOpacity: v });
      syncGlassSurfaceDom(undefined, {
        glassSurfaces,
        glassOpacity: v,
      });
    }, 120);
  }

  async function onThemeImportPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      themeImportErr = t("settings.themeImportZipErr");
      return;
    }
    themeImportBusy = true;
    themeImportErr = "";
    themeImportOk = "";
    themeExportOk = "";
    themeExportErr = "";
    try {
      const data = await api.restoreBackup(file, { themeOnly: true });
      if (!data.themeImported) {
        themeImportErr = t("settings.themeImportZipErr");
        return;
      }
      // Server is source of truth (theme + glass + customTheme + bg).
      await session.pullUserState({ skipFlush: true });
      reloadFromPrefs();
      themeImportOk = t("settings.themeImportSuccess");
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      themeImportErr = e instanceof Error ? e.message : String(e);
    } finally {
      themeImportBusy = false;
    }
  }

  async function runThemeExport() {
    themeExportBusy = true;
    themeExportErr = "";
    themeExportOk = "";
    themeImportErr = "";
    themeImportOk = "";
    try {
      const name = await api.downloadThemeExport();
      themeExportOk = t("settings.themeExportSuccess", { name });
      window.setTimeout(() => (themeExportOk = ""), 5000);
    } catch (e) {
      themeExportErr = e instanceof Error ? e.message : String(e);
    } finally {
      themeExportBusy = false;
    }
  }
</script>

<Panel title={t("settings.panel.ui")} class="settings-ui-section">
  {#snippet actions()}
    <input
      bind:this={themeImportInput}
      class="sr-only"
      type="file"
      accept=".zip,application/zip"
      aria-label={t("settings.themeImportAria")}
      onchange={(e) => void onThemeImportPicked(e)}
    />
    <Button
      variant="ghost"
      disabled={themeImportBusy || themeExportBusy || hubBusy}
      aria-label={t("settings.themeImportAria")}
      onclick={() => themeImportInput?.click()}
    >
      {themeImportBusy ? t("settings.themeImportRunning") : t("settings.themeImportCta")}
    </Button>
    <Button
      variant="ghost"
      class="settings-theme-export-btn"
      disabled={themeExportBusy || themeImportBusy || hubBusy}
      aria-label={t("settings.themeExportAria")}
      title={t("settings.themeExportTitle")}
      onclick={() => void runThemeExport()}
    >
      <UiIcon name="download" class="settings-theme-export-btn__ic" />
    </Button>
  {/snippet}
  {#if themeImportErr}
    <p class="hint warn settings-theme-import-msg" role="alert">{themeImportErr}</p>
  {/if}
  {#if themeImportOk}
    <p class="hint ok settings-theme-import-msg" aria-live="polite">{themeImportOk}</p>
  {/if}
  {#if themeExportErr}
    <p class="hint warn settings-theme-import-msg" role="alert">{themeExportErr}</p>
  {/if}
  {#if themeExportOk}
    <p class="hint ok settings-theme-import-msg" aria-live="polite">{themeExportOk}</p>
  {/if}
  <SettingsFieldsGrid>
    <div class="settings-fields-grid__span settings-language-field">
      <Field label={t("settings.language")}>
        <Select
          options={languageOptions}
          bind:value={localeValue}
          aria-label={t("settings.language")}
          onchange={(ev) => onLocaleChange(selectValue(ev))}
        />
      </Field>
    </div>
    <div class="settings-theme-glass-block settings-fields-grid__span">
      <div
        class="settings-theme-glass-row"
        class:settings-theme-glass-row--custom={themeValue === "custom"}
      >
        <div class="settings-theme-glass-row__theme">
          <Field label={t("settings.theme")}>
            <ThemePicker
              value={themeValue}
              customTheme={customThemeValue}
              onchange={onThemeChange}
              {onCustomThemeChange}
              ariaLabel={t("settings.themeAria")}
              showCustomizeButton={false}
              customizeOpen={customThemeDialogOpen}
              onCustomizeOpenChange={(open) => (customThemeDialogOpen = open)}
            />
          </Field>
        </div>
        {#if themeValue === "custom"}
          <button
            type="button"
            class="theme-picker__customize-btn settings-theme-glass-row__customize"
            onclick={() => (customThemeDialogOpen = true)}
          >
            {t("themePicker.customEditBtn")}
          </button>
        {/if}
        <div
          class="settings-glass-opacity settings-theme-glass-row__opacity"
          class:is-disabled={!glassSurfaces}
          aria-disabled={!glassSurfaces}
          title={glassSurfaces ? undefined : t("core.settings.glassOffHint")}
        >
          <span class="settings-glass-opacity__label">{t("settings.glassOpacity")}</span>
          <input
            type="range"
            class="settings-glass-opacity__slider"
            min={0}
            max={100}
            step={1}
            disabled={!glassSurfaces}
            value={glassTransparency}
            oninput={(e) =>
              onGlassOpacityChange(100 - Number((e.currentTarget as HTMLInputElement).value))}
            aria-label={t("settings.glassOpacity")}
          />
          <input
            type="number"
            class="settings-glass-opacity__num"
            min={0}
            max={100}
            inputmode="numeric"
            disabled={!glassSurfaces}
            value={glassTransparency}
            oninput={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              if (el.value === "") return;
              onGlassOpacityChange(100 - Number(el.value));
            }}
            aria-label={t("settings.glassOpacity")}
          />
          <span class="settings-glass-opacity__unit" aria-hidden="true">%</span>
        </div>
      </div>
      <label class="settings-glass-toggle">
        <input
          type="checkbox"
          class="settings-checkbox"
          checked={glassSurfaces}
          onchange={(e) => onGlassSurfacesChange((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>{t("settings.glassSurfaces")}</span>
      </label>
    </div>
    <LayoutWidthFields />
  </SettingsFieldsGrid>
</Panel>
<Panel title={t("settings.panel.features")} class="settings-features-section">
  <p class="hint">{t("settings.features.hint")}</p>
  <div class="settings-features">
    {#each FEATURE_SWITCHES as f (f.key)}
      <label class="settings-glass-toggle">
        <input
          type="checkbox"
          class="settings-checkbox"
          checked={featurePrefs[f.key]}
          onchange={(e) => patchUserPrefs({ [f.key]: (e.currentTarget as HTMLInputElement).checked })}
        />
        <span>{t(f.labelKey)}</span>
      </label>
    {/each}
  </div>
</Panel>
<Panel title={t("settings.panel.player")} class="settings-player-section">
  <SettingsFieldsGrid>
    <Field label={t("settings.visualizer")}>
      <Select
        options={vizOptions}
        bind:value={vizValue}
        aria-label={t("settings.visualizerAria")}
        onchange={(ev) => onVizChange(selectValue(ev))}
      />
    </Field>
    <Field label={t("settings.crossfade")}>
      <Select
        options={fadeOptions}
        bind:value={fadeValue}
        aria-label={t("settings.crossfadeAria")}
        onchange={(ev) => onFadeChange(selectValue(ev))}
      />
    </Field>
  </SettingsFieldsGrid>
  <p class="hint">{t("settings.playerHint")}</p>
</Panel>
<Panel title={t("settings.panel.shortcuts")} class="settings-shortcuts-section">
  <ShortcutList items={shortcuts} />
</Panel>

<style>
  .settings-features {
    display: flex;
    flex-wrap: wrap;
    gap: var(--rk-space-sm) var(--rk-space-lg);
  }

  .settings-glass-opacity.is-disabled {
    opacity: 0.45;
  }

  .settings-glass-opacity.is-disabled :global(input) {
    cursor: not-allowed;
  }

  .hint {
    margin: 0 0 0.85rem;
    color: var(--rk-muted);
  }

  .hint.warn {
    color: var(--rk-danger, #e85d5d);
  }

  .hint.ok {
    color: var(--rk-accent-2, #6bcf8e);
  }
</style>
