/**
 * Locale tables for the hub panel: same keys in every language (`de` follows
 * `en`), same placeholders, and every key the source asks for exists.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COOKIE_CODES, PODCAST_CODES, POWER_CODES, hubErrorKey } from "./hubErrors.ts";
import { hubActivityCode, hubActivityText, hubText } from "../../../../packages/ui/src/lib/hubText.ts";
import { pluralCategory, pluralKey } from "../../../../packages/ui/src/lib/plural.ts";
import { intlTag, interpolate, normalizeLocale, pickLocale } from "./locale.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(SRC, "locales", name), "utf8"));
const it = load("it.json");
const en = load("en.json");
const de = load("de.json");

const placeholders = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(svelte|ts)$/.test(name)) out.push(path);
  }
  return out;
}

describe("locale tables", () => {
  test("EN and IT have the same keys", () => {
    const itKeys = Object.keys(it).sort();
    const enKeys = Object.keys(en).sort();
    const onlyIt = itKeys.filter((k) => !(k in en));
    const onlyEn = enKeys.filter((k) => !(k in it));
    assert.deepEqual(onlyIt, [], `missing in en.json: ${onlyIt.join(", ")}`);
    assert.deepEqual(onlyEn, [], `missing in it.json: ${onlyEn.join(", ")}`);
  });

  test("DE has exactly the EN keys", () => {
    const missing = Object.keys(en).filter((k) => !(k in de)).sort();
    const extra = Object.keys(de).filter((k) => !(k in en)).sort();
    assert.deepEqual(missing, [], `missing in de.json: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `in de.json but not in en.json: ${extra.join(", ")}`);
  });

  test("DE keeps the EN placeholders", () => {
    for (const key of Object.keys(en)) {
      if (!(key in de)) continue;
      assert.deepEqual(placeholders(de[key]), placeholders(en[key]), `placeholders of ${key} (de)`);
    }
  });

  test("no empty strings", () => {
    for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
      for (const [k, v] of Object.entries(table)) {
        assert.ok(typeof v === "string" && v.trim(), `${name}.json ${k} is empty`);
      }
    }
  });

  test("placeholders match between languages", () => {
    for (const key of Object.keys(it)) {
      if (!(key in en)) continue;
      assert.deepEqual(placeholders(en[key]), placeholders(it[key]), `placeholders of ${key}`);
    }
  });

  test("every literal t(\"…\") key used in the source exists", () => {
    const used = new Set();
    const keyLike = /^[a-z][\w-]*(\.[\w/-]+)+$/;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
      // `t(cond ? "a.b" : "c.d")` and `{ key: "errors.x" }` (hubErrors.ts)
      for (const m of text.matchAll(/\bt\(\s*\w+\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
        used.add(m[1]);
        used.add(m[2]);
      }
      for (const m of text.matchAll(/\bkey:\s*"([^"]+)"/g)) {
        if (keyLike.test(m[1])) used.add(m[1]);
      }
    }
    assert.ok(used.size > 100, `found only ${used.size} keys: is the scan broken?`);
    const missing = [...used].filter((k) => !(k in it) || !(k in en)).sort();
    assert.deepEqual(missing, [], `keys used but not translated: ${missing.join(", ")}`);
  });

  test("every literal tp(\"…\", n) key has its plural forms", () => {
    const used = new Set();
    for (const file of sourceFiles(SRC)) {
      // Comments quote calls as examples (`tp("x", n)`): skip them.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
      for (const m of text.matchAll(/\btp\(\s*"([^"]+)"/g)) used.add(m[1]);
    }
    assert.ok(used.size > 10, `found only ${used.size} plural keys`);
    const missing = [];
    for (const key of used) {
      for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
        for (const form of ["one", "other"]) {
          if (!(`${key}.${form}` in table)) missing.push(`${name}: ${key}.${form}`);
        }
      }
    }
    assert.deepEqual(missing.sort(), []);
  });

  test("plural families are complete and never shadow a plain key", () => {
    for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
      for (const key of Object.keys(table)) {
        const one = /^(.*)\.one$/.exec(key);
        if (one) assert.ok(`${one[1]}.other` in table, `${name}: ${key} without .other`);
        const other = /^(.*)\.other$/.exec(key);
        if (other) assert.ok(!(other[1] in table), `${name}: ${other[1]} is plain and plural`);
      }
    }
  });

  test("dynamic key families are complete", () => {
    const families = {
      nav: ["status", "library", "jobs", "diagnostics", "activity", "backup", "accounts", "integrations", "podcasts", "network"],
      lede: ["status", "library", "jobs", "diagnostics", "activity", "backup", "accounts", "integrations", "podcasts", "network"],
      "podcasts.kind": ["rss", "rtl", "ytdlp", "live"],
      lang: ["it", "en", "de"],
      layout: ["artist/album/track", "artist/track", "flat", "tags"],
      "jobs.status": ["running", "done", "failed", "canceled"],
      "network.remote.status": ["stopped", "starting", "running", "error"],
      "scan.mode": ["incremental", "full"],
      "power.mode": ["off", "always", "whenActive"],
      "power.mode.hint": ["off", "always", "whenActive"],
      "power.msg": ["off", "always", "whenActive"],
      "power.what": ["stream", "job", "remote", "recent"],
      "errors.code": ["power_unsupported", "power_refused", "power_failed"],
    };
    for (const [prefix, ids] of Object.entries(families)) {
      for (const id of ids) {
        const key = `${prefix}.${id}`;
        assert.ok(key in it && key in en, `missing ${key}`);
      }
    }
  });
});

describe("locale choice", () => {
  test("saved choice wins, then the browser, then Italian", () => {
    assert.equal(pickLocale("en", ["it-IT"]), "en");
    assert.equal(pickLocale(null, ["en-US", "it"]), "en");
    assert.equal(pickLocale("xx", ["fr-FR", "it-CH"]), "it");
    assert.equal(pickLocale(null, ["fr-FR", "es"]), "it");
    assert.equal(pickLocale(null, ["de-DE", "en"]), "de");
    assert.equal(pickLocale("de", ["it-IT"]), "de");
    assert.equal(pickLocale(undefined, []), "it");
  });

  test("normalizeLocale accepts regional tags", () => {
    assert.equal(normalizeLocale("EN_gb"), "en");
    assert.equal(normalizeLocale("it-IT"), "it");
    assert.equal(normalizeLocale("de"), "de");
    assert.equal(normalizeLocale("de_AT"), "de");
    assert.equal(normalizeLocale("fr"), null);
    assert.equal(normalizeLocale(42), null);
  });

  test("Intl tag keeps the browser's region when it matches", () => {
    assert.equal(intlTag("en", ["en-US"]), "en-US");
    assert.equal(intlTag("en", ["it-IT"]), "en-GB");
    assert.equal(intlTag("it", []), "it-IT");
    assert.equal(intlTag("de", ["de-AT"]), "de-AT");
    assert.equal(intlTag("de", ["en-US"]), "de-DE");
  });

  test("plural forms follow Intl.PluralRules, .other as the fallback", () => {
    const has = (k) => k in it;
    assert.equal(pluralKey("count.tracks", 1, "it-IT", has), "count.tracks.one");
    assert.equal(pluralKey("count.tracks", 0, "it-IT", has), "count.tracks.other");
    assert.equal(pluralKey("count.tracks", 2, "en-GB", has), "count.tracks.other");
    assert.equal(pluralKey("count.tracks", 1, "de-DE", has), "count.tracks.one");
    assert.equal(pluralKey("no.such", 1, "it-IT", has), "no.such.other");
    assert.equal(pluralCategory("pl", 3), "few");
    assert.equal(pluralKey("count.tracks", 3, "pl", has), "count.tracks.other");
    const tp = (table, key, n, vars) =>
      interpolate(table[pluralKey(key, n, "it-IT", (k) => k in table)], { n, ...vars });
    assert.equal(tp(it, "count.tracks", 1), "1 brano");
    assert.equal(tp(it, "count.tracks", 12), "12 brani");
    assert.equal(
      interpolate(it["msg.libraryReady"], { tracks: tp(it, "count.tracks", 1) }),
      "Libreria pronta: 1 brano.",
    );
    assert.equal(tp(en, "integrations.yt.cookiesEntries", 1, { yt: 1 }), "1 cookie, 1 for YouTube/Google");
  });

  test("interpolate replaces every occurrence", () => {
    assert.equal(interpolate("{{a}} and {{a}} / {{b}}", { a: 1, b: "x" }), "1 and 1 / x");
    assert.equal(interpolate("plain"), "plain");
  });
});

describe("hub errors", () => {
  test("403 from a remote panel explains how to enable remote admin", () => {
    const remote =
      "Operazione di macchina disponibile solo dal computer dell'hub (abilita l'accesso remoto nel pannello hub)";
    assert.deepEqual(hubErrorKey(403, remote, true), { key: "errors.forbiddenRemote" });
    assert.deepEqual(
      hubErrorKey(403, "Operazione disponibile solo dal computer dell'hub (abilita l'accesso remoto nel pannello hub)", true),
      { key: "errors.forbiddenRemote" },
    );
    assert.deepEqual(hubErrorKey(403, "only from the hub's computer / enable remote admin", true), {
      key: "errors.forbiddenRemote",
    });
  });

  test("403 for a non-default account", () => {
    assert.deepEqual(
      hubErrorKey(403, "Solo l'account Default può eseguire le operazioni di macchina", true),
      { key: "errors.forbiddenDefault" },
    );
  });

  test("other 403s", () => {
    assert.deepEqual(hubErrorKey(403, null, false), { key: "errors.forbidden" });
    assert.deepEqual(hubErrorKey(403, "forbidden_origin", true), { key: "errors.forbidden" });
    assert.deepEqual(hubErrorKey(403, "Nope, not today", true), {
      key: "errors.forbiddenDetail",
      vars: { detail: "Nope, not today" },
    });
  });

  test("gateway pages without a body mean the hub is down", () => {
    assert.deepEqual(hubErrorKey(502, null, false), {
      key: "errors.unreachableStatus",
      vars: { status: 502 },
    });
    assert.equal(hubErrorKey(500, "database is locked", true), null);
    assert.deepEqual(hubErrorKey(404, null, false), { key: "errors.notAvailable" });
  });

  test("podcast codes have their own text, in every language", () => {
    for (const code of PODCAST_CODES) {
      const k = hubErrorKey(code === "ytdlp_disabled" ? 403 : 422, code, true);
      assert.deepEqual(k, { key: `errors.code.${code}` });
      for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
        assert.ok(k.key in table, `${name}.json: missing ${k.key}`);
      }
    }
  });

  test("sleep prevention codes have their own text, in every language", () => {
    for (const code of POWER_CODES) {
      const k = hubErrorKey(409, code, true);
      assert.deepEqual(k, { key: `errors.code.${code}` });
      for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
        assert.ok(k.key in table, `${name}.json: missing ${k.key}`);
      }
    }
  });

  test("refused cookie uploads have their own text, in every language", () => {
    for (const code of COOKIE_CODES) {
      const k = hubErrorKey(400, code, true);
      assert.deepEqual(k, { key: `errors.code.${code}` });
      for (const [name, table] of [["it", it], ["en", en], ["de", de]]) {
        assert.ok(k.key in table, `${name}.json: missing ${k.key}`);
      }
    }
  });

  test("known hub codes", () => {
    assert.deepEqual(hubErrorKey(409, "scan already in progress", true), { key: "errors.scanBusy" });
    // 5.3 hubs answer stable codes instead of text.
    assert.deepEqual(hubErrorKey(409, "scan_in_progress", true), { key: "errors.scanBusy" });
    assert.deepEqual(hubErrorKey(400, "music_root_not_set", true), { key: "errors.musicRootNotSet" });
    assert.deepEqual(hubErrorKey(400, "music_root_not_directory", true), { key: "errors.musicRootMissing" });
    assert.deepEqual(hubErrorKey(413, "file_too_large", true), { key: "errors.tooLarge" });
    assert.deepEqual(hubErrorKey(400, "music_root not set", true), { key: "errors.musicRootNotSet" });
    assert.equal(hubErrorKey(400, "something else", true), null);
  });
});

/* ── Hub-coded text (activity log, jobs) ── */

const CORE_SRC = fileURLToPath(new URL("../../../../crates/core/src", import.meta.url));
const CLIENT_HUB = fileURLToPath(new URL("../../../client-ui/src/locales/hub", import.meta.url));

function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...rustFiles(path));
    else if (name.endsWith(".rs")) out.push(path);
  }
  return out;
}

/** Every code the hub can write: literal `ActivityEvent::new("kind", "action"` and `*_coded(…"a.b"`. */
function hubCodes() {
  const activity = new Set(["download.finished", "download.cancelled", "download.failed"]);
  const jobs = new Set(["cancelRequested", "interrupted"]);
  for (const file of rustFiles(CORE_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/ActivityEvent::new\(\s*"(\w+)",\s*"(\w+)"/g)) {
      activity.add(`${m[1]}.${m[2]}`);
    }
    for (const m of src.matchAll(/\b(?:start|progress|message|finish)_coded\(/g)) {
      const tail = src.slice(m.index, m.index + 400);
      const code = /"([a-z]\w*\.[a-z]\w*)"/.exec(tail);
      if (code) jobs.add(code[1]);
    }
  }
  return { activity: [...activity].sort(), jobs: [...jobs].sort() };
}

const tr = (table) => ({
  has: (key) => key in table,
  t: (key, vars) => interpolate(table[key] ?? key, vars),
  formatNumber: (n) => String(n),
});

describe("hub-coded text", () => {
  const codes = hubCodes();
  const clientIt = load2(CLIENT_HUB, "it.json");
  const clientEn = load2(CLIENT_HUB, "en.json");
  const clientDe = load2(CLIENT_HUB, "de.json");

  test("the scan finds the hub's codes", () => {
    assert.ok(codes.activity.length >= 20, codes.activity.join(", "));
    assert.ok(codes.jobs.includes("scan.title") && codes.jobs.includes("thumbs.done"));
  });

  test("every activity code is translated in the panel and in the client", () => {
    for (const code of codes.activity) {
      const key = `hub.activity.${code}`;
      for (const [name, table] of [
        ["panel it", it],
        ["panel en", en],
        ["panel de", de],
        ["client it", clientIt],
        ["client en", clientEn],
        ["client de", clientDe],
      ]) {
        assert.ok(key in table, `${name}: missing ${key}`);
      }
    }
  });

  test("every job code is translated in the panel", () => {
    for (const code of codes.jobs) {
      const key = `hub.job.${code}`;
      assert.ok(key in it && key in en && key in de, `missing ${key}`);
    }
  });

  test("codes translate with params, unknown codes keep the hub text", () => {
    const text = hubText(tr(en), "job", "scan.title", { mode: "full" }, "Scan libreria (full)");
    assert.equal(text, "Library scan (full)");
    assert.equal(
      hubText(tr(it), "job", "scan.done", { indexed: 533, removed: 0 }, "x"),
      "533 brani indicizzati, 0 rimossi",
    );
    assert.equal(
      hubText(tr(de), "job", "scan.done", { indexed: 533, removed: 0 }, "x"),
      "533 Titel indiziert, 0 entfernt",
    );
    assert.equal(hubText(tr(en), "job", "nope.unknown", {}, "raw"), "raw");
    // A placeholder left empty falls back too.
    assert.equal(hubText(tr(en), "job", "scan.done", {}, "raw"), "raw");
  });

  test("older uncoded lines are read back from their text", () => {
    assert.deepEqual(hubActivityCode({ kind: "settings", message: "settings updated" }), {
      code: "settings.updated",
      params: {},
    });
    assert.equal(
      hubActivityText(tr(it), {
        kind: "download",
        message: "download finished (download_single): Salmo — 1 ok, 0 skipped, 0 failed",
      }),
      "Download completato (singolo): Salmo — 1 riusciti, 0 saltati, 0 non riusciti",
    );
    assert.equal(
      hubActivityText(tr(it), { kind: "scan", message: "library scan started (incremental)" }),
      "Scansione libreria avviata (incrementale)",
    );
    assert.equal(hubActivityText(tr(it), { kind: "x", message: "something new" }), "something new");
  });
});

function load2(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}
