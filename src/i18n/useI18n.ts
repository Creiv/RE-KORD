import { useCallback, useMemo } from "react";
import { useUserSettingsSlice } from "../context/UserStateContext";
import type { AppLocale } from "../types";
import { DE } from "./de";
import { EN } from "./en";
import { IT } from "./it";
import { translate } from "./translate";

const TABLES: Record<AppLocale, Record<string, string>> = {
  en: EN,
  it: IT,
  de: DE,
};

export function useI18n() {
  const { settings, updateSettings } = useUserSettingsSlice();
  const locale = settings.locale;
  const table = TABLES[locale] ?? TABLES.en;
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      translate(table, key, vars),
    [table]
  );
  const sortLocale = useMemo(() => locale, [locale]);
  return {
    t,
    locale,
    sortLocale,
    setLocale: (next: AppLocale) => updateSettings({ locale: next }),
  };
}
