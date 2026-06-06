import { useCallback, useEffect, useRef, useState } from "react";
import { CustomThemeDialog } from "./CustomThemeDialog";
import { useI18n } from "../i18n/useI18n";
import { DEFAULT_CUSTOM_THEME, THEME_CATALOG } from "../lib/themeCatalog";
import type { CustomThemeSettings, ThemeMode } from "../types";

function ThemeStrip({
  bg,
  bgImageUrl,
  section,
  accent,
  accent2,
  t,
}: {
  bg: string;
  bgImageUrl?: string | null;
  section: string;
  accent: string;
  accent2: string;
  t: (k: string) => string;
}) {
  return (
    <span className="theme-picker__strip" aria-hidden>
      <span
        className="theme-picker__strip-seg theme-picker__strip-seg--bg"
        style={
          bgImageUrl
            ? {
                backgroundImage: `url("${bgImageUrl}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : { background: bg }
        }
        title={t("themePicker.stripBg")}
      />
      <span className="theme-picker__strip-seg" style={{ background: section }} title={t("themePicker.stripSection")} />
      <span className="theme-picker__strip-seg" style={{ background: accent }} title={t("themePicker.stripAccent1")} />
      <span className="theme-picker__strip-seg" style={{ background: accent2 }} title={t("themePicker.stripAccent2")} />
    </span>
  );
}

export function ThemePicker({
  value,
  onChange,
  customTheme = DEFAULT_CUSTOM_THEME,
  onCustomThemeChange,
  customThemeBgPreviewUrl = null,
  onCustomThemeBgUpload,
  onCustomThemeBgClear,
}: {
  value: ThemeMode;
  onChange: (theme: ThemeMode) => void;
  customTheme?: CustomThemeSettings;
  onCustomThemeChange?: (theme: CustomThemeSettings) => void;
  customThemeBgPreviewUrl?: string | null;
  onCustomThemeBgUpload?: (
    file: File,
  ) => Promise<{ bgImage: string; bgImageRev: number }>;
  onCustomThemeBgClear?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customThemeBgBusy, setCustomThemeBgBusy] = useState(false);
  const [customThemeBgErr, setCustomThemeBgErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const curBase = THEME_CATALOG.find((th) => th.id === value) ?? THEME_CATALOG[0];
  const cur =
    curBase.id === "custom" ? { ...curBase, ...customTheme } : curBase;
  const bgPreviewUrl =
    value === "custom" &&
    customTheme.bgMode === "image" &&
    customTheme.bgImage
      ? customThemeBgPreviewUrl
      : null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback(
    (id: ThemeMode) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  const applyCustomTheme = useCallback(
    (next: CustomThemeSettings) => {
      onCustomThemeChange?.(next);
      if (value !== "custom") onChange("custom");
    },
    [onChange, onCustomThemeChange, value],
  );

  const handleUploadBg = useCallback(
    async (file: File) => {
      if (!onCustomThemeBgUpload) {
        throw new Error("upload unavailable");
      }
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
        const err = t("themePicker.customBgTypeErr");
        setCustomThemeBgErr(err);
        throw new Error(err);
      }
      setCustomThemeBgErr(null);
      setCustomThemeBgBusy(true);
      try {
        return await onCustomThemeBgUpload(file);
      } catch (e: unknown) {
        setCustomThemeBgErr(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setCustomThemeBgBusy(false);
      }
    },
    [onCustomThemeBgUpload, t],
  );

  const handleClearBg = useCallback(async () => {
    if (!onCustomThemeBgClear) return;
    setCustomThemeBgErr(null);
    setCustomThemeBgBusy(true);
    try {
      await onCustomThemeBgClear();
    } catch (e: unknown) {
      setCustomThemeBgErr(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setCustomThemeBgBusy(false);
    }
  }, [onCustomThemeBgClear]);

  const groups = [
    { id: "dual", label: t("themePicker.groupDual") },
    { id: "dark", label: t("themePicker.groupDark") },
    { id: "light", label: t("themePicker.groupLight") },
    { id: "color", label: t("themePicker.groupColor") },
    { id: "custom", label: t("themePicker.groupCustom") },
  ] as const;

  return (
    <div className={`theme-picker${open ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="theme-picker__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="theme-picker__label">{t(`theme.${cur.id}`)}</span>
        <ThemeStrip
          bg={cur.bg}
          bgImageUrl={bgPreviewUrl}
          section={cur.section}
          accent={cur.accent}
          accent2={cur.accent2}
          t={t}
        />
      </button>
      {open ? (
        <ul className="theme-picker__menu" role="listbox">
          {groups.map((group) => {
            const entries = THEME_CATALOG.filter((entry) => entry.group === group.id);
            if (!entries.length) return null;
            return (
              <li className="theme-picker__group" key={group.id} role="none">
                <div className="theme-picker__group-label">{group.label}</div>
                <ul className="theme-picker__group-list" role="none">
                  {entries.map((entry) => {
                    const preview =
                      entry.id === "custom" ? { ...entry, ...customTheme } : entry;
                    return (
                      <li key={entry.id} role="none">
                        <button
                          type="button"
                          role="option"
                          aria-selected={entry.id === value}
                          className={
                            entry.id === value
                              ? "theme-picker__opt is-active"
                              : "theme-picker__opt"
                          }
                          onClick={() => pick(entry.id)}
                        >
                          <span className="theme-picker__name">{t(`theme.${entry.id}`)}</span>
                          <ThemeStrip
                            bg={preview.bg}
                            bgImageUrl={
                              entry.id === "custom" &&
                              customTheme.bgMode === "image" &&
                              customTheme.bgImage
                                ? customThemeBgPreviewUrl
                                : null
                            }
                            section={preview.section}
                            accent={preview.accent}
                            accent2={preview.accent2}
                            t={t}
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
      {value === "custom" ? (
        <button
          type="button"
          className="ghost-btn ghost-btn--sm theme-picker__customize-btn"
          onClick={() => setCustomDialogOpen(true)}
        >
          {t("themePicker.customEditBtn")}
        </button>
      ) : null}
      {onCustomThemeBgUpload && onCustomThemeBgClear ? (
        <CustomThemeDialog
          open={customDialogOpen}
          theme={customTheme}
          onThemeChange={applyCustomTheme}
          onClose={() => setCustomDialogOpen(false)}
          onUploadBg={handleUploadBg}
          onClearBg={handleClearBg}
          bgBusy={customThemeBgBusy}
          bgError={customThemeBgErr}
        />
      ) : null}
    </div>
  );
}
