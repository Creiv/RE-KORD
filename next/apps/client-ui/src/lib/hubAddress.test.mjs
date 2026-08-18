/**
 * Indirizzi dell'hub scritti a mano o letti da un QR.
 * Importa il modulo vero: si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_HUB_PORT,
  formatHubLabel,
  guessHubMode,
  hubBaseFromParts,
  hubBaseFromQr,
  isValidPort,
  parseHubAddress,
} from "./hubAddress.ts";

test("un IP nudo prende http e la porta dell'hub", () => {
  const a = parseHubAddress("192.168.1.20");
  assert.equal(a.base, `http://192.168.1.20:${DEFAULT_HUB_PORT}`);
  assert.equal(a.https, false);
});

test("IP con porta: la porta scritta vince", () => {
  assert.equal(parseHubAddress("192.168.1.20:9000").base, "http://192.168.1.20:9000");
});

test("un tunnel https resta senza porta", () => {
  const a = parseHubAddress("https://nome.trycloudflare.com");
  assert.equal(a.base, "https://nome.trycloudflare.com");
  assert.equal(a.https, true);
  assert.equal(a.port, "443");
});

test("il percorso in coda si butta: serve solo l'origine", () => {
  assert.equal(
    parseHubAddress("http://192.168.1.20:7420/admin/network").base,
    "http://192.168.1.20:7420",
  );
  assert.equal(parseHubAddress("192.168.1.20:7420/").base, "http://192.168.1.20:7420");
});

test("stringhe che non sono indirizzi", () => {
  assert.equal(parseHubAddress(""), null);
  assert.equal(parseHubAddress("   "), null);
  assert.equal(parseHubAddress("http://"), null);
});

test("porte fuori scala", () => {
  assert.equal(isValidPort("7420"), true);
  assert.equal(isValidPort("0"), false);
  assert.equal(isValidPort("65536"), false);
  assert.equal(isValidPort("74a0"), false);
  assert.equal(isValidPort(""), false);
});

test("dai due campi IP e porta", () => {
  assert.equal(hubBaseFromParts("192.168.1.20", "7420"), "http://192.168.1.20:7420");
  assert.equal(hubBaseFromParts("rekord.local", "7420"), "http://rekord.local:7420");
  assert.equal(hubBaseFromParts("", "7420"), null);
  assert.equal(hubBaseFromParts("192.168.1.20", "abc"), null);
});

test("un indirizzo completo incollato nel campo IP vince sulla porta accanto", () => {
  assert.equal(
    hubBaseFromParts("http://192.168.1.30:9999", "7420"),
    "http://192.168.1.30:9999",
  );
  assert.equal(hubBaseFromParts("192.168.1.30:9999", "7420"), "http://192.168.1.30:9999");
});

test("QR con URL in chiaro", () => {
  assert.equal(
    hubBaseFromQr("https://nome.trycloudflare.com"),
    "https://nome.trycloudflare.com",
  );
  assert.equal(
    hubBaseFromQr("http://192.168.1.20:7420/admin"),
    "http://192.168.1.20:7420",
  );
});

test("QR con JSON attorno all'URL", () => {
  assert.equal(
    hubBaseFromQr('{"url":"http://192.168.1.20:7420"}'),
    "http://192.168.1.20:7420",
  );
  assert.equal(
    hubBaseFromQr('{"publicUrl":"https://nome.trycloudflare.com"}'),
    "https://nome.trycloudflare.com",
  );
  assert.equal(hubBaseFromQr("{non un json}"), null);
  assert.equal(hubBaseFromQr('{"altro":1}'), null);
});

test("il modo per riempire i campi giusti", () => {
  assert.equal(guessHubMode("192.168.1.20:7420"), "local");
  assert.equal(guessHubMode("https://nome.trycloudflare.com"), "public");
  assert.equal(guessHubMode(""), "local");
});

test("etichetta senza schema", () => {
  assert.equal(formatHubLabel("http://192.168.1.20:7420"), "192.168.1.20:7420");
  assert.equal(formatHubLabel("https://nome.trycloudflare.com"), "nome.trycloudflare.com");
});
