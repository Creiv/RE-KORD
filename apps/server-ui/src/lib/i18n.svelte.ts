/**
 * Translations for the hub panel (same shape as the client's i18n: flat keys,
 * `{{var}}` placeholders, Italian as the fallback table).
 */
import {
  hubActivityText,
  hubText,
  pluralKey,
  setUiLabels,
  uiLabels,
  type HubActivityEntry,
  type HubParams,
  type HubTextArea,
  type HubTextTranslator,
} from "@rekord/ui";
import de from "../locales/de.json";
import en from "../locales/en.json";
import it from "../locales/it.json";
import {
  intlTag,
  interpolate,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  pickLocale,
  type AdminLocale,
} from "./locale";

export type { AdminLocale };

const TABLES: Record<AdminLocale, Record<string, string>> = {
  it: it as Record<string, string>,
  en: en as Record<string, string>,
  de: de as Record<string, string>,
};

function readStored(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return [navigator.language, ...(navigator.languages ?? [])].filter(
    (l): l is string => typeof l === "string" && l.length > 0,
  );
}

class I18nStore {
  locale = $state<AdminLocale>(pickLocale(readStored(), browserLanguages()));

  /** Tag handed to `Intl` for numbers and dates. */
  readonly intl = $derived(intlTag(this.locale, browserLanguages()));

  t = (key: string, vars?: Record<string, string | number>): string => {
    const table = TABLES[this.locale] ?? TABLES.it;
    return interpolate(table[key] ?? TABLES.it[key] ?? key, vars);
  };

  /**
   * Plural-aware lookup: `tp("x", n)` reads `x.one` / `x.other` (by
   * `Intl.PluralRules`), with `{{n}}` set to the formatted count.
   */
  tp = (key: string, n: number, vars?: Record<string, string | number>): string =>
    this.t(pluralKey(key, n, this.intl, this.has), {
      n: new Intl.NumberFormat(this.intl).format(n),
      ...vars,
    });

  /** Whether a key exists (current locale or the Italian fallback). */
  has = (key: string): boolean => {
    const table = TABLES[this.locale] ?? TABLES.it;
    return key in table || key in TABLES.it;
  };

  setLocale(next: string) {
    this.locale = normalizeLocale(next) ?? "it";
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, this.locale);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    this.apply();
  }

  /** `<html lang>` and the shared components' built-in labels. */
  apply() {
    document.documentElement.lang = this.locale;
    const labels: Record<string, string> = {
      close: this.t("ui.close"),
      empty: this.t("ui.empty"),
      searchPlaceholder: this.t("ui.searchPlaceholder"),
      search: this.t("ui.search"),
      back: this.t("ui.back"),
    };
    // Only push labels the shared package knows about.
    setUiLabels(
      Object.fromEntries(
        Object.entries(labels).filter(([k]) => k in uiLabels),
      ) as Partial<typeof uiLabels>,
    );
  }
}

export const i18n = new I18nStore();

/** Reactive when called from templates and `$derived`. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}

/** Plural helper: `tp("x.count", n)` reads `x.count.one` / `x.count.other`. */
export function tp(key: string, n: number, vars?: Record<string, string | number>): string {
  return i18n.tp(key, n, vars);
}

const hubTranslator: HubTextTranslator = {
  has: (key) => i18n.has(key),
  t: (key, vars) => i18n.t(key, vars),
  formatNumber: (n) => formatNumber(n),
};

/**
 * Hub text with a stable code (activity lines, job titles / details) in the
 * panel's language; `fallback` is the hub's own wording.
 */
export function hubMsg(
  area: HubTextArea,
  code: string | null | undefined,
  params: HubParams,
  fallback: string,
): string {
  return hubText(hubTranslator, area, code, params, fallback);
}

/** An activity-log line in the panel's language (older uncoded lines included). */
export function hubActivityMsg(entry: HubActivityEntry): string {
  return hubActivityText(hubTranslator, entry);
}

/** Activity kind label ("scan" → "Scansione"); the raw kind when unknown. */
export function hubKind(kind: string): string {
  const key = `hub.kind.${kind.trim()}`;
  return i18n.has(key) ? i18n.t(key) : kind;
}

export function formatNumber(
  value: number | null | undefined,
  options?: Intl.NumberFormatOptions,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(i18n.intl, options).format(value);
}

/** 0.83 → "83%" (or "83 %" where the locale wants it). */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return new Intl.NumberFormat(i18n.intl, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(i18n.intl, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(d);
}

/** A clock time ("12:03") today, date and time otherwise. */
export function formatClock(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(
    i18n.intl,
    today ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" },
  ).format(d);
}

/** Bytes → human size, used for disk and DB figures. */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${units[unit]}`;
}

export function formatDuration(secs?: number | null): string {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.trunc(secs));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return t("time.daysHours", { d: days, h: hours });
  if (hours > 0) return t("time.hoursMinutes", { h: hours, m: mins });
  if (mins > 0) return t("time.minutesSeconds", { m: mins, s: s % 60 });
  return t("time.seconds", { s });
}
