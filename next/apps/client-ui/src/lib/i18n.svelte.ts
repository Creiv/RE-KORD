import en from "../locales/en.json";
import it from "../locales/it.json";
import {
  loadUserPrefs,
  normalizeLocale,
  patchUserPrefs,
  type AppLocale,
} from "./userPrefs";

export type { AppLocale };

const TABLES: Record<AppLocale, Record<string, string>> = {
  it: it as Record<string, string>,
  en: en as Record<string, string>,
};

function translate(
  table: Record<string, string>,
  key: string,
  vars?: Record<string, string | number>,
): string {
  let s = table[key] ?? TABLES.it[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return s;
}

class I18nStore {
  locale = $state<AppLocale>(normalizeLocale(loadUserPrefs().locale));

  get sortLocale(): string {
    return this.locale === "it" ? "it" : "en";
  }

  t = (key: string, vars?: Record<string, string | number>): string => {
    const table = TABLES[this.locale] ?? TABLES.it;
    return translate(table, key, vars);
  };

  setLocale(next: AppLocale) {
    this.locale = normalizeLocale(next);
    patchUserPrefs({ locale: this.locale });
    document.documentElement.lang = this.locale;
  }

  /** Apply saved locale to store + `<html lang>` (startup / after prefs reload). */
  applySaved() {
    this.locale = normalizeLocale(loadUserPrefs().locale);
    document.documentElement.lang = this.locale;
  }
}

export const i18n = new I18nStore();

/** Convenience helper — reactive when called from Svelte templates. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}
