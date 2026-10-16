/**
 * Plural forms for the flat `{{var}}` locale tables of the client and the hub
 * panel: a counted string is a family of keys, `x.one` / `x.other` (and any
 * other CLDR category a language needs), picked with `Intl.PluralRules`.
 * `x.other` is the fallback, so a language only lists the forms it uses.
 */

const rulesCache = new Map<string, Intl.PluralRules>();

/** CLDR plural category of `n` in `locale` ("one", "other", …). */
export function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  let rules = rulesCache.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("it");
    }
    rulesCache.set(locale, rules);
  }
  return rules.select(Number.isFinite(n) ? n : 0);
}

/** Key of the form to show: `${key}.${category}` when it exists, else `${key}.other`. */
export function pluralKey(
  key: string,
  n: number,
  locale: string,
  has: (key: string) => boolean,
): string {
  const exact = `${key}.${pluralCategory(locale, n)}`;
  return has(exact) ? exact : `${key}.other`;
}
