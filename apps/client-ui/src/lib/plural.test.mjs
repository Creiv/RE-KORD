/**
 * Plural forms: `tp("x", n)` reads `x.one` / `x.other` through the shared
 * `pluralKey` helper (`@rekord/ui`), checked here against the real tables.
 *
 * Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { pluralCategory, pluralKey } from "../../../../packages/ui/src/lib/plural.ts";

const LOCALES = fileURLToPath(new URL("../locales", import.meta.url));
const TAGS = { it: "it-IT", en: "en-US", de: "de-DE" };

/** Base table plus every area fragment, merged the way `i18n.svelte.ts` does. */
function table(lang) {
  const merged = {};
  for (const entry of readdirSync(LOCALES)) {
    const dir = join(LOCALES, entry);
    if (statSync(dir).isDirectory()) {
      Object.assign(merged, JSON.parse(readFileSync(join(dir, `${lang}.json`), "utf8")));
    }
  }
  return Object.assign(merged, JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), "utf8")));
}

const TABLES = Object.fromEntries(Object.keys(TAGS).map((l) => [l, table(l)]));

/** Same lookup as the app's `tp` (Italian fallback, `{{n}}` always set). */
function tp(lang, key, n, vars = {}) {
  const tab = TABLES[lang];
  const has = (k) => k in tab || k in TABLES.it;
  const k = pluralKey(key, n, TAGS[lang], has);
  const text = tab[k] ?? TABLES.it[k] ?? k;
  return Object.entries({ n: String(n), ...vars }).reduce(
    (s, [name, v]) => s.replaceAll(`{{${name}}}`, String(v)),
    text,
  );
}

function t(lang, key, vars = {}) {
  const text = TABLES[lang][key] ?? TABLES.it[key] ?? key;
  return Object.entries(vars).reduce((s, [name, v]) => s.replaceAll(`{{${name}}}`, String(v)), text);
}

describe("pluralKey", () => {
  const has = (k) => ["x.one", "x.other", "y.other"].includes(k);

  test("one and other in Italian, English and German", () => {
    for (const tag of Object.values(TAGS)) {
      assert.equal(pluralKey("x", 1, tag, has), "x.one", tag);
      assert.equal(pluralKey("x", 0, tag, has), "x.other", tag);
      assert.equal(pluralKey("x", 2, tag, has), "x.other", tag);
      assert.equal(pluralKey("x", 1000, tag, has), "x.other", tag);
    }
  });

  test("a missing form falls back to .other", () => {
    assert.equal(pluralKey("y", 1, "it-IT", has), "y.other");
    // Polish has "few": no such key here, so .other.
    assert.equal(pluralCategory("pl", 3), "few");
    assert.equal(pluralKey("x", 3, "pl", has), "x.other");
  });

  test("odd input does not throw", () => {
    assert.equal(pluralCategory("it-IT", Number.NaN), "other");
    assert.equal(pluralKey("x", 1, "not a locale!", has), "x.one");
  });
});

describe("counted strings", () => {
  test("artist subtitle agrees with its counts", () => {
    const sub = (lang, albums, tracks) =>
      t(lang, "library.artistSubtitle", {
        albums: tp(lang, "library.albumsCount", albums),
        tracks: tp(lang, "library.tracksCount", tracks),
      });
    assert.equal(sub("it", 1, 1), "1 album · 1 brano");
    assert.equal(sub("it", 2, 12), "2 album · 12 brani");
    assert.equal(sub("en", 1, 1), "1 album · 1 track");
    assert.equal(sub("en", 3, 30), "3 albums · 30 tracks");
    assert.equal(sub("de", 1, 2), "1 Album · 2 Titel");
  });

  test("the single-track download confirm talks about one track", () => {
    const path = { path: "Artist/Album" };
    assert.equal(tp("it", "studio.dl.confirmAlbumFolder", 1, path), "Scaricare il brano in «Artist/Album»?");
    assert.equal(tp("it", "studio.dl.confirmAlbumFolder", 0, path), "Scaricare i brani in «Artist/Album»?");
    assert.match(tp("en", "studio.dl.confirmAlbumFolder", 1, path), /^Download the track /);
    assert.match(tp("de", "studio.dl.confirmAlbumFolder", 5, path), /^Die Titel /);
  });

  test("every plural family has its .other form in every language", () => {
    for (const [lang, tab] of Object.entries(TABLES)) {
      for (const key of Object.keys(tab)) {
        const m = /^(.*)\.(zero|one|two|few|many)$/.exec(key);
        if (m) assert.ok(`${m[1]}.other` in tab, `${lang}: ${key} without ${m[1]}.other`);
      }
    }
  });

  test("no key is both a plain string and a plural family", () => {
    for (const [lang, tab] of Object.entries(TABLES)) {
      for (const key of Object.keys(tab)) {
        const m = /^(.*)\.other$/.exec(key);
        if (m) assert.ok(!(m[1] in tab), `${lang}: ${m[1]} is plain and plural`);
      }
    }
  });
});
