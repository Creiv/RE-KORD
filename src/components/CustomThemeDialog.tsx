import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { customThemeBgImageUrl } from "../lib/api";
import { DEFAULT_CUSTOM_THEME } from "../lib/themeCatalog";
import type { CustomThemeBgMode, CustomThemeSettings } from "../types";

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
  return (
    <div className="custom-theme-dialog__preview-strip" aria-hidden>
      <span
        className="custom-theme-dialog__preview-strip-seg custom-theme-dialog__preview-strip-seg--bg"
        style={
          bgMode === "image" && bgImageUrl
            ? {
                backgroundImage: `url("${bgImageUrl}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : { background: theme.bg }
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
  initialTheme,
  onSave,
  onClose,
  onUploadBg,
  onClearBg,
}: {
  open: boolean;
  initialTheme: CustomThemeSettings;
  onSave: (theme: CustomThemeSettings) => void;
  onClose: () => void;
  onUploadBg: (file: File) => Promise<{ bgImage: string; bgImageRev: number }>;
  onClearBg: () => Promise<void>;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<CustomThemeSettings>(initialTheme);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState<string | null>(null);
  const [draftBgRev, setDraftBgRev] = useState<number | null | undefined>(
    initialTheme.bgImageRev,
  );

  useEffect(() => {
    if (!open) return;
    setDraft(initialTheme);
    setDraftBgRev(initialTheme.bgImageRev);
    setBgErr(null);
    setBgBusy(false);
  }, [open, initialTheme]);

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
    panelRef.current.querySelector<HTMLElement>('[data-custom-theme-primary="1"]')?.focus();
  }, [open]);

  const bgMode: CustomThemeBgMode = draft.bgMode === "image" ? "image" : "color";
  const bgPreviewUrl =
    bgMode === "image" && draft.bgImage
      ? customThemeBgImageUrl(draftBgRev ?? undefined)
      : null;

  const setBgMode = useCallback((next: CustomThemeBgMode) => {
    setDraft((prev) => ({ ...prev, bgMode: next }));
  }, []);

  const updateColor = useCallback(
    (key: keyof CustomThemeSettings, next: string) => {
      setDraft((prev) => ({ ...prev, [key]: next }));
    },
    [],
  );

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!f) return;
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(f.type)) {
      setBgErr(t("themePicker.customBgTypeErr"));
      return;
    }
    setBgErr(null);
    setBgBusy(true);
    try {
      const { bgImage, bgImageRev } = await onUploadBg(f);
      setDraft((prev) => ({
        ...prev,
        bgMode: "image",
        bgImage,
        bgImageRev,
      }));
      setDraftBgRev(bgImageRev);
    } catch (e: unknown) {
      setBgErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBgBusy(false);
    }
  };

  const onClearImage = async () => {
    setBgErr(null);
    setBgBusy(true);
    try {
      await onClearBg();
      setDraft((prev) => {
        const { bgImage: _b, bgImageRev: _r, ...rest } = prev;
        void _b;
        void _r;
        return { ...rest, bgMode: "color" };
      });
      setDraftBgRev(null);
    } catch (e: unknown) {
      setBgErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBgBusy(false);
    }
  };

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  if (!open) return null;

  const colorFields = (
    ["section", "accent", "accent2"] as const
  ).map((key) => (
    <ColorSwatchField
      key={key}
      label={t(`themePicker.custom.${key}`)}
      value={draft[key]}
      onChange={(next) => updateColor(key, next)}
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
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="custom-theme-dialog__head">
          <p className="eyebrow" id="custom-theme-dialog-title">
            {t("themePicker.customDialogTitle")}
          </p>
          <ThemePreviewStrip theme={draft} bgImageUrl={bgPreviewUrl} t={t} />
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
              onClick={() => setBgMode("color")}
            >
              <span
                className="custom-theme-dialog__bg-mode-swatch"
                style={{ background: draft.bg }}
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
              onClick={() => setBgMode("image")}
            >
              <span
                className={`custom-theme-dialog__bg-mode-swatch custom-theme-dialog__bg-mode-swatch--image${
                  bgPreviewUrl ? " has-image" : ""
                }`}
                style={
                  bgPreviewUrl
                    ? { backgroundImage: `url("${bgPreviewUrl}")` }
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
              value={draft.bg}
              onChange={(next) => updateColor("bg", next)}
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
                    style={{ backgroundImage: `url("${bgPreviewUrl}")` }}
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
                    : draft.bgImage
                      ? t("themePicker.customBgChange")
                      : t("themePicker.customBgChoose")}
                </span>
              </button>
              {draft.bgImage ? (
                <button
                  type="button"
                  className="ghost-btn ghost-btn--sm custom-theme-dialog__image-clear"
                  disabled={bgBusy}
                  onClick={() => void onClearImage()}
                >
                  {t("themePicker.customBgClear")}
                </button>
              ) : null}
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

        {bgErr ? (
          <p className="subtle sm warnline custom-theme-dialog__err">{bgErr}</p>
        ) : null}

        <div className="custom-theme-dialog__section">
          <span className="custom-theme-dialog__section-label">
            {t("themePicker.customColorsHeading")}
          </span>
          <div className="custom-theme-dialog__swatch-grid">{colorFields}</div>
        </div>

        <div className="meta-edit-actions custom-theme-dialog__actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t("trackMeta.editCancel")}
          </button>
          <button
            type="button"
            className="primary-btn"
            data-custom-theme-primary="1"
            disabled={bgBusy}
            onClick={handleSave}
          >
            {t("trackMeta.editSave")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}