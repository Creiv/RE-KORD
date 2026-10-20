/**
 * Panel access key: shared storage with the client, same-origin only, QR
 * carries the key in the fragment.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = { origin: "HTTP://192.168.1.5:7420" };

const {
  accessKeyHeaders,
  accessKeyReason,
  clearAccessKey,
  getAccessKey,
  isWellFormedAccessKey,
  qrValueWithKey,
  setAccessKey,
  withAccessKeyQuery,
} = await import("./accessKey.ts");

const KEY = "k".repeat(32);

test("stored under the client's key for this origin", () => {
  setAccessKey(KEY);
  assert.equal(store.get("rekord.accessKey:http://192.168.1.5:7420"), KEY);
  assert.equal(getAccessKey(), KEY);
  clearAccessKey();
  assert.equal(getAccessKey(), null);
});

test("header and query only for same-origin paths", () => {
  assert.deepEqual(accessKeyHeaders("/api/v1/health", KEY), { "X-Rekord-Access-Key": KEY });
  assert.deepEqual(accessKeyHeaders("https://evil.example/x", KEY), {});
  assert.deepEqual(accessKeyHeaders("//evil.example/x", KEY), {});
  assert.deepEqual(accessKeyHeaders("/\\evil.example/x", KEY), {});
  assert.deepEqual(accessKeyHeaders("/api/v1/health", null), {});
  assert.equal(withAccessKeyQuery("/media/a.mp3", KEY), `/media/a.mp3?accessKey=${KEY}`);
  assert.equal(withAccessKeyQuery("/api/x?v=1#f", KEY), `/api/x?v=1&accessKey=${KEY}#f`);
  assert.equal(withAccessKeyQuery("https://evil.example/x", KEY), "https://evil.example/x");
  assert.equal(withAccessKeyQuery("//evil.example/x", KEY), "//evil.example/x");
});

test("QR puts the key in the fragment, never in the query", () => {
  assert.equal(
    qrValueWithKey("http://192.168.1.5:7420/", KEY),
    `http://192.168.1.5:7420/#rekordKey=${KEY}`,
  );
  const v = qrValueWithKey("https://abc.trycloudflare.com", "a.b_c~d-" + "x".repeat(24));
  assert.ok(v.startsWith("https://abc.trycloudflare.com/#rekordKey="));
  assert.ok(!v.includes("?"));
});

test("format and codes follow the hub", () => {
  assert.ok(isWellFormedAccessKey("a".repeat(32)));
  assert.ok(!isWellFormedAccessKey("a".repeat(31)));
  assert.ok(!isWellFormedAccessKey(`${"a".repeat(32)} `));
  assert.equal(accessKeyReason("access_key_required"), "required");
  assert.equal(accessKeyReason("access_key_invalid"), "invalid");
  assert.equal(accessKeyReason("access_key_rate_limited"), "locked");
  assert.equal(accessKeyReason("forbidden_remote"), null);
});
