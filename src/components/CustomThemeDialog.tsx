import {
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { customThemeBgImageUrl } from "../lib/api";
import { customThemeBgImageCss, CUSTOM_THEME_BG_IMAGE_FITS } from "../lib/customThemeBgFit";
import type { CustomThemeBgMode, CustomThemeSettings } from "../types";

function bgImageLayerStyle(
  theme: CustomThemeSettings,
  bgImageUrl: string | null,
  opts?: { forceImage?: boolean },
): CSSProperties | undefined {
  const bgMode = theme.bgMode === "image" ? "image" : "color";
  const showImage = bgImageUrl && (opts?.forceImage || bgMode === "image");
  if (showImage) {
    const fit = customThemeBgImageCss(theme.bgImageFit);
    return {
      backgroundColor: theme.bg,
      backgroundImage: `url("${bgImageUrl}")`,
      backgroundSize: fit.size,
      backgroundPosition: fit.position,
      backgroundRepeat: fit.repeat,
    };
  }
  if (bgMode === "color") {
    return { background: theme.bg };
  }
  return undefined;
}

function ThemePreviewStrip({
  theme,
  bgImageUrl,
  t,
}: {
  theme: CustomThemeSettings;
  bgImageUrl: string | null;
  t: (k: string) => string;
}) {
  const bgMode = theme.bgMode === "image" ? "image" : "color";
  const bgLayerStyle = bgImageLayerStyle(theme, bgImageUrl);
  return (
    <div className="custom-theme-dialog__preview-strip" aria-hidden>
      <span
        className="custom-theme-dialog__preview-strip-seg custom-theme-dialog__preview-strip-seg--bg"
        style={
          bgLayerStyle ??
          (bgMode === "color" ? { background: theme.bg } : undefined)
        }
        title={t("themePicker.stripBg")}
      />
      <span
        className="custom-theme-dialog__preview-strip-seg"
        style={{ background: theme.section }}
        title={t("themePicker.stripSection")}
      />
      <span
        className="custom-theme-dialog__preview-strip-seg"
        style={{ background: theme.accent }}
        title={t("themePicker.stripAccent1")}
      />
      <span
        className="custom-theme-dialog__preview-strip-seg"
        style={{ background: theme.accent2 }}
        title={t("themePicker.stripAccent2")}
      />
    </div>
  );
}

function ColorSwatchField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      className="custom-theme-dialog__swatch"
      onClick={() => inputRef.current?.click()}
      aria-label={label}
    >
      <span
        className="custom-theme-dialog__swatch-chip"
        style={{ background: value }}
        aria-hidden
      />
      <span className="custom-theme-dialog__swatch-label">{label}</span>
      <span className="custom-theme-dialog__swatch-hex" aria-hidden>
        {value.toUpperCase()}
      </span>
      <input
        ref={inputRef}
        type="color"
        className="custom-theme-dialog__swatch-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        aria-hidden
      />
    </button>
  );
}

export function CustomThemeDialog({
  open,
  theme,
  onThemeChange,
  onClose,
  onUploadBg,
  onClearBg,
  bgBusy = false,
  bgError = null,
}: {
  open: boolean;
  theme: CustomThemeSettings;
  onThemeChange: (theme: CustomThemeSettings) => void;
  onClose: () => void;
  onUploadBg: (file: File) => Promise<{ bgImage: string; bgImageRev: number }>;
  onClearBg: () => Promise<void>;
  bgBusy?: boolean;
  bgError?: string | null;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    panelRef.current.focus();
  }, [open]);

  const bgMode: CustomThemeBgMode = theme.bgMode === "image" ? "image" : "color";
  const storedBgImageUrl = theme.bgImage
    ? customThemeBgImageUrl(theme.bgImageRev ?? undefined)
    : null;
  const bgPreviewUrl = bgMode === "image" ? storedBgImageUrl : null;
  const bgPreviewStyle: CSSProperties | undefined =
    bgPreviewUrl != null
      ? bgImageLayerStyle(theme, bgPreviewUrl)
      : undefined;

  const patchTheme = useCallback(
    (patch: Partial<CustomThemeSettings>) => {
      onThemeChange({ ...theme, ...patch });
    },
    [onThemeChange, theme],
  );

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!f || bgBusy) return;
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(f.type)) return;
    try {
      const { bgImage, bgImageRev } = await onUploadBg(f);
      onThemeChange({
        ...theme,
        bgMode: "image",
        bgImage,
        bgImageRev,
      });
    } catch {
      /* parent handles error state */
    }
  };

  const onClearImage = async () => {
    if (bgBusy) return;
    try {
      await onClearBg();
      const { bgImage: _b, bgImageRev: _r, ...rest } = theme;
      void _b;
      void _r;
      onThemeChange({ ...rest, bgMode: "color" });
    } catch {
      /* parent handles error state */
    }
  };

  if (!open) return null;

  const colorFields = (
    ["section", "accent", "accent2"] as const
  ).map((key) => (
    <ColorSwatchField
      key={key}
      label={t(`themePicker.custom.${key}`)}
      value={theme[key]}
      onChange={(next) => patchTheme({ [key]: next })}
    />
  ));

  return createPortal(
    <div
      className="meta-edit-backdrop custom-theme-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="meta-edit-dialog surface-card custom-theme-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-theme-dialog-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="custom-theme-dialog__head">
          <div className="custom-theme-dialog__title-row">
            <p className="eyebrow" id="custom-theme-dialog-title">
              {t("themePicker.customDialogTitle")}
            </p>
            <button
              type="button"
              className="text-btn custom-theme-dialog__close"
              onClick={onClose}
            >
              {t("trackMeta.editClose")}
            </button>
          </div>
          <ThemePreviewStrip theme={theme} bgImageUrl={bgPreviewUrl} t={t} />
        </div>

        <div className="custom-theme-dialog__section">
          <span className="custom-theme-dialog__section-label">
            {t("themePicker.custom.bg")}
          </span>
          <div
            className="custom-theme-dialog__bg-mode"
            role="group"
            aria-label={t("themePicker.customBgModeAria")}
          >
            <button
              type="button"
              className={`custom-theme-dialog__bg-mode-opt${
                bgMode === "color" ? " is-active" : ""
              }`}
              aria-pressed={bgMode === "color"}
              onClick={() => patchTheme({ bgMode: "color" })}
            >
              <span
                className="custom-theme-dialog__bg-mode-swatch"
                style={{ background: theme.bg }}
                aria-hidden
              />
              <span>{t("themePicker.customBgColor")}</span>
            </button>
            <button
              type="button"
              className={`custom-theme-dialog__bg-mode-opt${
                bgMode === "image" ? " is-active" : ""
              }`}
              aria-pressed={bgMode === "image"}
              onClick={() => patchTheme({ bgMode: "image" })}
            >
              <span
                className={`custom-theme-dialog__bg-mode-swatch custom-theme-dialog__bg-mode-swatch--image${
                  storedBgImageUrl ? " has-image" : ""
                }`}
                style={
                  storedBgImageUrl
                    ? bgImageLayerStyle(theme, storedBgImageUrl, { forceImage: true })
                    : undefined
                }
                aria-hidden
              />
              <span>{t("themePicker.customBgImage")}</span>
            </button>
          </div>
        </div>

        {bgMode === "color" ? (
          <div className="custom-theme-dialog__section">
            <ColorSwatchField
              label={t("themePicker.custom.bg")}
              value={theme.bg}
              onChange={(next) => patchTheme({ bg: next })}
            />
          </div>
        ) : (
          <div className="custom-theme-dialog__section">
            <div className="custom-theme-dialog__image-panel">
              <button
                type="button"
                className="custom-theme-dialog__image-drop"
                disabled={bgBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {bgPreviewUrl ? (
                  <span
                    className="custom-theme-dialog__image-preview"
                    style={bgPreviewStyle}
                    aria-hidden
                  />
                ) : (
                  <span className="custom-theme-dialog__image-placeholder">
                    {t("themePicker.customBgDropHint")}
                  </span>
                )}
                <span className="custom-theme-dialog__image-cta">
                  {bgBusy
                    ? t("settings.saving")
                    : theme.bgImage
                      ? t("themePicker.customBgChange")
                      : t("themePicker.customBgChoose")}
                </span>
              </button>
              <div className="custom-theme-dialog__image-toolbar">
                {theme.bgImage ? (
                  <button
                    type="button"
                    className="ghost-btn ghost-btn--sm custom-theme-dialog__image-clear"
                    disabled={bgBusy}
                    onClick={() => void onClearImage()}
                  >
                    {t("themePicker.customBgClear")}
                  </button>
                ) : (
                  <span className="custom-theme-dialog__image-toolbar-spacer" aria-hidden />
                )}
                <label className="custom-theme-dialog__fit-control">
                  <span className="custom-theme-dialog__fit-label">
                    {t("themePicker.customBgFitLabel")}
                  </span>
                  <select
                    className="custom-theme-dialog__fit-select"
                    value={theme.bgImageFit ?? "cover"}
                    disabled={bgBusy}
                    aria-label={t("themePicker.customBgFitAria")}
                    onChange={(event) =>
                      patchTheme({
                        bgImageFit: event.target.value as CustomThemeSettings["bgImageFit"],
                      })
                    }
                  >
                    {CUSTOM_THEME_BG_IMAGE_FITS.map((fit) => (
                      <option key={fit} value={fit}>
                        {t(`themePicker.customBgFit.${fit}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              onChange={(event) => void onFileChange(event)}
            />
          </div>
        )}

        {bgError ? (
          <p className="subtle sm warnline custom-theme-dialog__err">{bgError}</p>
        ) : null}

        <div className="custom-theme-dialog__section">
          <span className="custom-theme-dialog__section-label">
            {t("themePicker.customColorsHeading")}
          </span>
          <div className="custom-theme-dialog__swatch-grid">{colorFields}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
