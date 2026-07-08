import { ThemePicker } from "../../components/ThemePicker";
import {
  clearCustomThemeBg,
  customThemeBgImageUrl,
  uploadCustomThemeBg,
} from "../../lib/api";
import { APP_LOCALES, type AppLocale } from "../../types";
import type { UiSectionProps } from "./types";

export default function UiSection({
  t,
  locale,
  setLocale,
  settings,
  updateSettings,
  glassOpacityDraft,
  onGlassOpacityChange,
  customThemeDialogOpen,
  setCustomThemeDialogOpen,
}: UiSectionProps) {
  return (
    <section className="surface-card settings-ui-section">
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.uiEyebrow")}</p>
          <h2>{t("settings.uiHeading")}</h2>
        </div>
      </div>
      <div className="settings-grid settings-ui-section__grid">
        <label className="settings-ui-inline-control">
          <span>{t("settings.language")}</span>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as AppLocale)}
          >
            {APP_LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {loc === "en" ? t("settings.langEn") : t("settings.langIt")}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-ui-inline-control">
          <span>{t("settings.visualizer")}</span>
          <select
            value={settings.vizMode}
            onChange={(event) =>
              updateSettings({
                vizMode: event.target.value as
                  | "bars"
                  | "mirror"
                  | "osc"
                  | "oscSoft"
                  | "hmb"
                  | "signals"
                  | "discowall",
              })
            }
          >
            <option value="bars">{t("settings.vizBars")}</option>
            <option value="mirror">{t("settings.vizMirror")}</option>
            <option value="osc">{t("settings.vizOsc")}</option>
            <option value="oscSoft">{t("settings.vizOscSoft")}</option>
            <option value="hmb">{t("settings.vizHmb")}</option>
            <option value="signals">{t("settings.vizSignals")}</option>
            <option value="discowall">{t("settings.vizDiscowall")}</option>
          </select>
        </label>
        <div className="settings-theme-glass-block settings-ui-section__span">
          <div
            className={`settings-theme-glass-row${
              settings.theme === "custom"
                ? " settings-theme-glass-row--custom"
                : ""
            }`}
          >
            <div className="settings-ui-inline-control settings-theme-glass-row__theme">
              <span>{t("settings.theme")}</span>
              <ThemePicker
                value={settings.theme}
                onChange={(theme) => updateSettings({ theme })}
                customTheme={settings.customTheme}
                onCustomThemeChange={(customTheme) =>
                  updateSettings({ theme: "custom", customTheme })
                }
                customThemeBgPreviewUrl={
                  settings.customTheme?.bgMode === "image" &&
                  settings.customTheme?.bgImage
                    ? customThemeBgImageUrl(
                        settings.customTheme.bgImageRev ?? undefined,
                      )
                    : null
                }
                onCustomThemeBgUpload={uploadCustomThemeBg}
                onCustomThemeBgClear={clearCustomThemeBg}
                showCustomizeButton={false}
                customizeOpen={customThemeDialogOpen}
                onCustomizeOpenChange={setCustomThemeDialogOpen}
              />
            </div>
            {settings.theme === "custom" ? (
              <button
                type="button"
                className="ghost-btn settings-theme-glass-row__customize"
                onClick={() => setCustomThemeDialogOpen(true)}
              >
                {t("themePicker.customEditBtn")}
              </button>
            ) : null}
            <div className="settings-glass-opacity settings-theme-glass-row__opacity">
              <span className="settings-glass-opacity__label">
                {t("settings.glassOpacity")}
              </span>
              <input
                type="range"
                className="settings-glass-opacity__slider"
                min={0}
                max={100}
                step={1}
                disabled={!settings.glassSurfaces}
                value={glassOpacityDraft}
                onChange={(event) =>
                  onGlassOpacityChange(Number(event.target.value))
                }
                aria-label={t("settings.glassOpacity")}
              />
              <input
                type="number"
                className="ghost-input settings-glass-opacity__num"
                min={0}
                max={100}
                inputMode="numeric"
                disabled={!settings.glassSurfaces}
                value={glassOpacityDraft}
                onChange={(event) => {
                  if (event.target.value === "") return;
                  onGlassOpacityChange(Number(event.target.value));
                }}
                aria-label={t("settings.glassOpacity")}
              />
              <span className="settings-glass-opacity__unit" aria-hidden>
                %
              </span>
            </div>
          </div>
          <label className="settings-ui-inline-control settings-ui-inline-control--checkbox-row settings-theme-glass-block__checkbox">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={settings.glassSurfaces}
              onChange={(event) =>
                updateSettings({ glassSurfaces: event.target.checked })
              }
            />
            <span>{t("settings.glassSurfaces")}</span>
          </label>
        </div>
        <label className="settings-ui-inline-control settings-ui-inline-control--checkbox-row settings-ui-section__span">
          <input
            type="checkbox"
            className="settings-checkbox"
            checked={settings.plectrDisableVizBackdrop}
            onChange={(event) =>
              updateSettings({
                plectrDisableVizBackdrop: event.target.checked,
              })
            }
          />
          <span>{t("settings.plectrDisableVizBackdrop")}</span>
        </label>
        <label className="settings-ui-inline-control settings-ui-section__span">
          <span>{t("settings.trackTransitions")}</span>
          <select
            className="ghost-input w-full"
            title={t("settings.trackTransitionsHint")}
            value={String(settings.audioCrossfadeSec)}
            onChange={(event) =>
              updateSettings({
                audioCrossfadeSec: Number(event.target.value) as 0 | 3 | 5,
              })
            }
          >
            <option value="0">{t("settings.audioCrossfadeOff")}</option>
            <option value="3">{t("settings.audioCrossfade3")}</option>
            <option value="5">{t("settings.audioCrossfade5")}</option>
          </select>
        </label>
      </div>
    </section>
  );
}
