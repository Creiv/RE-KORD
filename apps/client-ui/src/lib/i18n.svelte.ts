// The subpath keeps the component library out of node tests that load this store.
import { pluralKey } from "@rekord/ui/plural";
import it from "../locales/it.json";
import {
  loadUserPrefs,
  normalizeLocale,
  patchUserPrefs,
  type AppLocale,
} from "./userPrefs";

export type { AppLocale };

type Table = Record<string, string>;

/**
 * Feature areas keep their strings in `locales/<area>/<locale>.json` so they can
 * grow without everyone editing the same two files; they merge over the base
 * tables (base keys win on collision, which should never happen).
 *
 * Italian is the fallback for every missing key, so it ships in the entry
 * chunk; the other languages are separate chunks fetched only when someone
 * uses them (see `ready` / `ensureLocale`).
 */
const IT_FRAGMENTS = import.meta.glob<Table>("../locales/*/it.json", {
  eager: true,
  import: "default",
});

type LazyLocale = Exclude<AppLocale, "it">;

/** Base table + area fragments of each lazily loaded language. */
const LAZY_TABLES: Record<LazyLocale, { base: () => Promise<Table>; fragments: Record<string, () => Promise<Table>> }> = {
  en: {
    base: () => import("../locales/en.json").then((m) => (m.default ?? m) as Table),
    fragments: import.meta.glob<Table>("../locales/*/en.json", { import: "default" }),
  },
  de: {
    base: () => import("../locales/de.json").then((m) => (m.default ?? m) as Table),
    fragments: import.meta.glob<Table>("../locales/*/de.json", { import: "default" }),
  },
};

/** BCP 47 tags for `Intl` (numbers, dates, plural rules, collation). */
const INTL_TAGS: Record<AppLocale, string> = {
  it: "it-IT",
  en: "en-US",
  de: "de-DE",
};

function mergeTables(fragments: Table[], base: Table): Table {
  const merged: Table = {};
  for (const table of fragments) Object.assign(merged, table);
  return Object.assign(merged, base);
}

const TABLES: Partial<Record<AppLocale, Table>> = {
  it: mergeTables(Object.values(IT_FRAGMENTS), it as Table),
};

const pendingTables = new Map<AppLocale, Promise<void>>();

/** Load a locale's table once (no-op for Italian, which is always there). */
function loadTable(locale: AppLocale): Promise<void> {
  if (TABLES[locale]) return Promise.resolve();
  const pending = pendingTables.get(locale);
  if (pending) return pending;
  const task = (async () => {
    const lazy = LAZY_TABLES[locale as LazyLocale];
    const [base, ...fragments] = await Promise.all([
      lazy.base(),
      ...Object.values(lazy.fragments).map((load) => load()),
    ]);
    TABLES[locale] = mergeTables(fragments, base);
  })().finally(() => pendingTables.delete(locale));
  pendingTables.set(locale, task);
  return task;
}

function translate(
  table: Table,
  key: string,
  vars?: Record<string, string | number>,
): string {
  let s = table[key] ?? TABLES.it![key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return s;
}

const plainNumberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dateFormats.set(key, f);
  }
  return f;
}

/** Date from an ISO string, epoch ms / s, or a Date; null when unreadable. */
function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    // Seconds (hub timestamps) vs milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (/^\d{4}$/.test(s)) return null;
  // Plain dates are calendar days, not UTC midnights.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type DateStyle = "date" | "datetime" | "time" | "long";

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: "medium" },
  datetime: { dateStyle: "medium", timeStyle: "short" },
  time: { timeStyle: "short" },
  long: { dateStyle: "long" },
};

class I18nStore {
  /** Locale whose table is loaded and used. */
  locale = $state<AppLocale>("it");

  /**
   * Resolves once the saved locale's table is loaded. Wait for it before
   * showing text (the connect gate does), or English users see Italian first.
   */
  ready: Promise<void>;

  constructor() {
    this.ready = this.ensureLocale(normalizeLocale(loadUserPrefs().locale));
  }

  get sortLocale(): string {
    return this.locale;
  }

  /** BCP 47 tag for number / date formatting (`Intl.*`, `toLocaleString`). */
  get formatLocale(): string {
    return INTL_TAGS[this.locale] ?? INTL_TAGS.it;
  }

  /** Switch to `next` as soon as its table is there (at once for Italian). */
  private ensureLocale(next: AppLocale): Promise<void> {
    this.wanted = next;
    if (TABLES[next]) {
      this.locale = next;
      return Promise.resolve();
    }
    return loadTable(next)
      .then(() => {
        // A later choice wins over a slow load.
        if (this.wanted === next) this.locale = next;
      })
      .catch(() => {
        /* chunk unreachable: stay on the Italian fallback */
      });
  }

  private wanted: AppLocale = "it";

  /**
   * Plural-aware lookup: picks `${key}.${category}` (`one`, `other`, …) from
   * `Intl.PluralRules`, falling back to `${key}.other`. `{{n}}` is always set.
   */
  tp = (key: string, n: number, vars?: Record<string, string | number>): string => {
    const table = TABLES[this.locale] ?? TABLES.it!;
    const pick = pluralKey(key, n, this.formatLocale, this.has);
    return translate(table, pick, { n: this.formatNumber(n), ...vars });
  };

  formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
    if (opts) return new Intl.NumberFormat(this.formatLocale, opts).format(n);
    // Hot path (game HUD, long lists): one cached formatter per locale.
    let nf = plainNumberFormats.get(this.formatLocale);
    if (!nf) {
      nf = new Intl.NumberFormat(this.formatLocale);
      plainNumberFormats.set(this.formatLocale, nf);
    }
    return nf.format(n);
  }

  /** Locale-aware date ("5 ott 2026" / "Oct 5, 2026" / "05.10.2026"); `—` when unknown. */
  formatDate(value: string | number | Date | null | undefined, style: DateStyle = "date"): string {
    const raw = typeof value === "string" ? value.trim() : value;
    // A bare year is already as precise as it gets.
    if (typeof raw === "string" && /^\d{4}$/.test(raw)) return raw;
    const d = toDate(raw);
    if (!d) return typeof raw === "string" && raw ? raw : "—";
    return dateFormat(this.formatLocale, DATE_STYLES[style]).format(d);
  }

  /**
   * "3 minuti fa" / "in 2 days" / "ieri"; falls back to the date past a
   * month. `—` when unknown.
   */
  formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
    const d = toDate(value);
    if (!d) return "—";
    const diffSec = Math.round((d.getTime() - now) / 1000);
    const abs = Math.abs(diffSec);
    if (abs < 45) return this.t("core.time.justNow");
    const rtf = new Intl.RelativeTimeFormat(this.formatLocale, { numeric: "auto" });
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
    if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), "day");
    return this.formatDate(d, "date");
  }

  /** Whether a key exists (current locale or the Italian fallback). */
  has = (key: string): boolean => {
    const table = TABLES[this.locale] ?? TABLES.it!;
    return key in table || key in TABLES.it!;
  };

  t = (key: string, vars?: Record<string, string | number>): string => {
    const table = TABLES[this.locale] ?? TABLES.it!;
    return translate(table, key, vars);
  };

  setLocale(next: AppLocale) {
    const locale = normalizeLocale(next);
    patchUserPrefs({ locale });
    document.documentElement.lang = locale;
    void this.ensureLocale(locale);
  }

  /** Apply saved locale to store + `<html lang>` (startup / after prefs reload). */
  applySaved() {
    const locale = normalizeLocale(loadUserPrefs().locale);
    document.documentElement.lang = locale;
    this.ready = this.ensureLocale(locale);
  }
}

export const i18n = new I18nStore();

/** Convenience helper — reactive when called from Svelte templates. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}

/** Plural helper — `tp("x.count", n)` reads `x.count.one` / `x.count.other`. */
export function tp(key: string, n: number, vars?: Record<string, string | number>): string {
  return i18n.tp(key, n, vars);
}

/** Locale-aware number formatting (reactive in templates). */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return i18n.formatNumber(n, opts);
}

/**
 * Locale-aware date for UI text: `fmtDate(iso)` → "5 ott 2026";
 * `fmtDate(iso, "datetime")` adds the time. Reactive in templates.
 */
export function fmtDate(
  value: string | number | Date | null | undefined,
  style: DateStyle = "date",
): string {
  return i18n.formatDate(value, style);
}

/** "3 minuti fa" / "yesterday"; the date past a month. Reactive in templates. */
export function fmtRelative(value: string | number | Date | null | undefined): string {
  return i18n.formatRelative(value);
}
