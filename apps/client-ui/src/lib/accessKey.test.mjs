/**
 * Access key storage and URLs: one key per hub, never sent to another origin.
 * Imports the real module: run with `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  accessKeyHeaders,
  accessKeyReason,
  clearAccessKey,
  getAccessKey,
  hubOrigin,
  isWellFormedAccessKey,
  setAccessKey,
  withAccessKeyQuery,
} = await import("./accessKey.ts");

const KEY = "k".repeat(32);
const HUB = "http://192.168.1.20:7420";

test("keys are stored per hub origin", () => {
  setAccessKey(`${HUB}/`, KEY);
  assert.equal(getAccessKey(HUB), KEY);
  assert.equal(getAccessKey("HTTP://192.168.1.20:7420"), KEY);
  assert.equal(getAccessKey("http://192.168.1.21:7420"), null);
  assert.equal(getAccessKey("https://192.168.1.20:7420"), null);
  assert.deepEqual(accessKeyHeaders("http://other:7420"), {});
  assert.deepEqual(accessKeyHeaders(HUB), { "X-Rekord-Access-Key": KEY });
  clearAccessKey(HUB);
  assert.equal(getAccessKey(HUB), null);
});

test("query key only on URLs of the same hub", () => {
  setAccessKey(HUB, KEY);
  assert.equal(
    withAccessKeyQuery(`${HUB}/media/a%20b.flac`, HUB),
    `${HUB}/media/a%20b.flac?accessKey=${KEY}`,
  );
  assert.equal(
    withAccessKeyQuery(`${HUB}/api/v1/transcode/x.wma?format=flac#t`, HUB),
    `${HUB}/api/v1/transcode/x.wma?format=flac&accessKey=${KEY}#t`,
  );
  assert.equal(withAccessKeyQuery("https://elsewhere.example/a.png", HUB), "https://elsewhere.example/a.png");
  assert.equal(withAccessKeyQuery("http://192.168.1.20:9999/media/a", HUB), "http://192.168.1.20:9999/media/a");
  assert.equal(withAccessKeyQuery("data:image/png;base64,xx", HUB), "data:image/png;base64,xx");
  assert.equal(withAccessKeyQuery("", HUB), "");
  // Protocol-relative paths point at another host.
  assert.equal(withAccessKeyQuery("//evil.example/a.png", HUB), "//evil.example/a.png");
  assert.equal(withAccessKeyQuery("/\\evil.example/a.png", HUB), "/\\evil.example/a.png");
  // Another hub with no key stored: untouched.
  assert.equal(withAccessKeyQuery("http://other:7420/media/a", "http://other:7420"), "http://other:7420/media/a");
  clearAccessKey(HUB);
  assert.equal(withAccessKeyQuery(`${HUB}/media/a`, HUB), `${HUB}/media/a`);
});

test("hub origin needs an http(s) base", () => {
  assert.equal(hubOrigin("tauri://localhost"), null);
  assert.equal(hubOrigin("not a url"), null);
  assert.equal(hubOrigin("https://abc.trycloudflare.com/admin"), "https://abc.trycloudflare.com");
});

test("well-formed keys follow the hub's rule", () => {
  assert.ok(isWellFormedAccessKey("a".repeat(32)));
  assert.ok(isWellFormedAccessKey("Ab0._~-".repeat(5)));
  assert.ok(!isWellFormedAccessKey("a".repeat(31)));
  assert.ok(!isWellFormedAccessKey("a".repeat(257)));
  assert.ok(!isWellFormedAccessKey(`${"a".repeat(32)} `));
  assert.ok(!isWellFormedAccessKey(`${"a".repeat(32)}/`));
});

test("hub codes map to the screen's reasons", () => {
  assert.equal(accessKeyReason("access_key_required"), "required");
  assert.equal(accessKeyReason("access_key_invalid"), "invalid");
  assert.equal(accessKeyReason("access_key_rate_limited"), "locked");
  assert.equal(accessKeyReason("forbidden_remote"), null);
  assert.equal(accessKeyReason(null), null);
});

test("a refused key blocks calls to that hub only, until a new key", async () => {
  const { isAccessKeyRefused, reportAccessKeyNeeded, clearAccessKeyRefusal } = await import("./accessKey.ts");
  const other = "http://192.168.1.99:7420";
  reportAccessKeyNeeded(HUB, "invalid");
  assert.ok(isAccessKeyRefused(`${HUB}/`));
  assert.ok(!isAccessKeyRefused(other));
  setAccessKey(HUB, KEY);
  assert.ok(!isAccessKeyRefused(HUB));
  reportAccessKeyNeeded(HUB, "required");
  clearAccessKeyRefusal(HUB);
  assert.ok(!isAccessKeyRefused(HUB));
  clearAccessKey(HUB);
});

test("key-screen messages are table keys, translated when shown (follow a language switch)", async () => {
  const { readFileSync } = await import("node:fs");
  const { initialAccessKeyMessage } = await import("./accessKey.ts");
  assert.deepEqual(initialAccessKeyMessage("invalid"), { key: "accessKey.errStoredInvalid" });
  assert.deepEqual(initialAccessKeyMessage("required", "accessKey.errQrInvalid"), { key: "accessKey.errQrInvalid" });
  assert.equal(initialAccessKeyMessage("required"), null);
  assert.equal(initialAccessKeyMessage("locked"), null);

  // Every key the screens keep as a message exists in it/en/de, and the
  // languages really differ (a stored, already translated string would not).
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sources = read("../components/AccessKeyScreen.svelte") + read("../components/ConnectScreen.svelte");
  const keys = new Set([
    ...[...sources.matchAll(/\b(?:key|noticeKey):[^"\n]*"(accessKey\.[\w.]+)"/g)].map((m) => m[1]),
    "accessKey.errStoredInvalid",
  ]);
  assert.ok(keys.size >= 6, `found ${[...keys]}`);
  const table = (lang) => JSON.parse(read(`../locales/core/${lang}.json`));
  const [it, en, de] = ["it", "en", "de"].map(table);
  for (const key of keys) {
    for (const [lang, tbl] of Object.entries({ it, en, de })) {
      assert.equal(typeof tbl[key], "string", `${key} missing in ${lang}`);
    }
    assert.notEqual(it[key], en[key], `${key}: it == en`);
    assert.notEqual(en[key], de[key], `${key}: en == de`);
  }
});
