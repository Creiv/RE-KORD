/**
 * Cast format / URL decisions (port of legacy castMedia.test.ts).
 *
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  CAST_TRANSCODE_EXTS,
  buildCastLoadPlan,
  castMimeTypeForRelPath,
  castStreamUrl,
  isLoopbackHostname,
  isWebCastSenderEnvironment,
  needsCastTranscode,
  resolveCastMediaBaseUrl,
  withCastAccessKey,
} = await import("./cast/castMedia.ts");

const LAN = "http://192.168.0.10:7799";

test("transcode list mirrors legacy: flac, ogg, opus, wav", () => {
  assert.deepEqual([...CAST_TRANSCODE_EXTS].sort(), ["flac", "ogg", "opus", "wav"]);
  assert.equal(needsCastTranscode("A/B/01 Song.FLAC"), true);
  assert.equal(needsCastTranscode("A/B/01.mp3"), false);
  assert.equal(needsCastTranscode("A/B/01.m4a"), false);
  assert.equal(needsCastTranscode("A/B.flac/noext"), false);
});

test("MIME by extension", () => {
  assert.equal(castMimeTypeForRelPath("x.flac"), "audio/flac");
  assert.equal(castMimeTypeForRelPath("x.m4a"), "audio/mp4");
  assert.equal(castMimeTypeForRelPath("x.weird"), "audio/mpeg");
});

test("loopback detection", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("127.1.2.3"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("app.localhost"), true);
  assert.equal(isLoopbackHostname("192.168.1.4"), false);
});

test("media base: non-loopback hub as is, else LAN URL, else public tunnel", () => {
  assert.equal(resolveCastMediaBaseUrl({ hubOrigin: LAN }), LAN);
  assert.equal(
    resolveCastMediaBaseUrl({ hubOrigin: "http://127.0.0.1:7799", lanUrl: `${LAN}/` }),
    LAN,
  );
  assert.equal(
    resolveCastMediaBaseUrl({
      hubOrigin: "http://localhost:5173",
      lanUrl: null,
      publicUrl: "https://x.trycloudflare.com/admin",
    }),
    "https://x.trycloudflare.com",
  );
  assert.equal(resolveCastMediaBaseUrl({ hubOrigin: "http://localhost:7799" }), null);
  assert.equal(resolveCastMediaBaseUrl({ hubOrigin: "tauri://localhost", lanUrl: "nope" }), null);
});

test("stream URL: transcode only when the hub can, path segments encoded", () => {
  const flac = castStreamUrl("Ar tist/Al#bum/01 ?.flac", LAN, { transcodeAvailable: true });
  assert.equal(flac.url, `${LAN}/api/v1/transcode/Ar%20tist/Al%23bum/01%20%3F.flac?format=mp3`);
  assert.equal(flac.contentType, "audio/mpeg");
  assert.equal(flac.transcoded, true);

  const aac = castStreamUrl("a/b.wav", LAN, { transcodeAvailable: true, format: "aac" });
  assert.equal(aac.contentType, "audio/aac");
  assert.ok(aac.url.endsWith("?format=aac"));

  const noTranscoder = castStreamUrl("a/b.flac", `${LAN}/`, { transcodeAvailable: false });
  assert.equal(noTranscoder.url, `${LAN}/media/a/b.flac`);
  assert.equal(noTranscoder.contentType, "audio/flac");

  const mp3 = castStreamUrl("a/b.mp3", LAN, { transcodeAvailable: true });
  assert.equal(mp3.url, `${LAN}/media/a/b.mp3`);
  assert.equal(mp3.transcoded, false);
});

test("load plan carries metadata and an absolute cover", () => {
  const plan = buildCastLoadPlan(
    {
      id: 1,
      rel_path: "A/B/01.ogg",
      title: "Song",
      artist_name: "Artist",
      album_name: "Album",
      duration_ms: 1000,
      track_number: 1,
      album_id: 42,
      artist_id: 7,
    },
    LAN,
    { transcodeAvailable: true },
  );
  assert.equal(plan.transcoded, true);
  assert.deepEqual(plan.metadata, {
    title: "Song",
    artist: "Artist",
    album: "Album",
    coverUrl: `${LAN}/api/v1/covers/album/42`,
  });
});

test("web sender only in Chrome-family secure contexts, never in Tauri / WebView / iOS", () => {
  const chrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
  const edge = `${chrome} Edg/129.0`;
  const androidChrome =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
  const androidWebView =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36";
  const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
  const iosChrome =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1";
  const ok = (userAgent, extra = {}) =>
    isWebCastSenderEnvironment({ userAgent, isSecureContext: true, isTauri: false, ...extra });
  assert.equal(ok(chrome), true);
  assert.equal(ok(edge), true);
  assert.equal(ok(androidChrome), true);
  assert.equal(ok(androidWebView), false);
  assert.equal(ok(firefox), false);
  assert.equal(ok(iosChrome), false);
  assert.equal(ok(chrome, { isTauri: true }), false);
  assert.equal(ok(chrome, { isSecureContext: false }), false);
});

const { CastLoadGate } = await import("./cast/castLoadGate.ts");

const finished = { player: "idle", idleReason: "finished" };

test("load gate: a burst of stale 'finished' statuses advances the queue once", () => {
  const gate = new CastLoadGate();
  gate.settle(gate.begin(), true); // track A on the receiver
  assert.equal(gate.takeFinish(finished), true); // A finished → advance to B
  const b = gate.begin(); // the advance loads B…
  // …while the receiver still reports A's "finished" (one update per property).
  assert.equal(gate.takeFinish(finished), false);
  assert.equal(gate.takeFinish(finished), false);
  assert.equal(gate.settled, false); // A's position / duration are not mirrored
  gate.settle(b, true);
  assert.equal(gate.settled, true);
  assert.equal(gate.takeFinish({ player: "playing", idleReason: null }), false);
  assert.equal(gate.takeFinish(finished), true); // B really finished
  assert.equal(gate.takeFinish(finished), false);
});

test("load gate: a superseded load cannot settle the newer one", () => {
  const gate = new CastLoadGate();
  const first = gate.begin();
  const second = gate.begin();
  gate.settle(first, true);
  assert.equal(gate.settled, false);
  assert.equal(gate.isCurrent(first), false);
  gate.settle(second, true);
  assert.equal(gate.settled, true);
});

test("load gate: a refused load does not skip ahead on the old 'finished'", () => {
  const gate = new CastLoadGate();
  gate.settle(gate.begin(), true);
  assert.equal(gate.takeFinish(finished), true);
  gate.settle(gate.begin(), false);
  assert.equal(gate.settled, true);
  assert.equal(gate.takeFinish(finished), false);
  gate.reset();
  assert.equal(gate.settled, true);
});

test("cast plan carries the access key only on the hub's own URLs", () => {
  const key = "k".repeat(32);
  const track = {
    id: 1,
    rel_path: "A/B/01.wma",
    title: "Song",
    artist_name: "Artist",
    album_name: "Album",
    duration_ms: 1000,
    track_number: 1,
    album_id: 42,
    artist_id: 7,
  };
  const plan = buildCastLoadPlan(track, LAN, { transcodeAvailable: true });
  const keyed = withCastAccessKey(plan, LAN, key);
  assert.equal(keyed.url, `${LAN}/media/A/B/01.wma?accessKey=${key}`);
  // A URL that already has a query gets `&`.
  const transcoded = { ...plan, url: `${LAN}/api/v1/transcode/A/B/01.ogg?format=mp3` };
  assert.equal(
    withCastAccessKey(transcoded, LAN, key).url,
    `${LAN}/api/v1/transcode/A/B/01.ogg?format=mp3&accessKey=${key}`,
  );
  assert.equal(keyed.metadata.coverUrl, `${LAN}/api/v1/covers/album/42?accessKey=${key}`);
  // No key stored: unchanged.
  assert.deepEqual(withCastAccessKey(plan, LAN, null), plan);
  // A cover on another origin never gets the key.
  const foreign = { ...plan, metadata: { ...plan.metadata, coverUrl: "https://img.example/x.jpg" } };
  assert.equal(withCastAccessKey(foreign, LAN, key).metadata.coverUrl, "https://img.example/x.jpg");
});
