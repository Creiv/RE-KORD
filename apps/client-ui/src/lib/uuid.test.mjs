/**
 * Download ids (`uuid.ts`): valid v4 UUIDs also without `crypto.randomUUID`
 * (plain-HTTP LAN hubs are not a secure context).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "./uuid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUuid falls back to getRandomValues outside secure contexts", (t) => {
  // An own property shadows the prototype's method, as in an insecure context.
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  t.after(() => delete crypto.randomUUID);
  assert.equal(typeof crypto.randomUUID, "undefined");
  const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, V4);
});

test("randomUuid uses crypto.randomUUID when present", () => {
  assert.match(randomUuid(), V4);
});
