/**
 * Studio pure helpers: yt-dlp log filter, path redaction, download summary.
 * `pnpm test` only globs `src/lib/*.test.mjs`; run this one with
 * `node --experimental-strip-types --import ./test-resolve-ts.mjs --test src/lib/studio/*.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectDownloadIssue,
  redactPaths,
  ytdlpLogDetailForUser,
} from "./ytdlpLogFilter.ts";
import { jsRuntimeLabel, jsRuntimeMissing, pickJsRuntime } from "./jsRuntime.ts";
import {
  batchCounts,
  jobOutcome,
  folderMatchKey,
  plannedReleaseFolders,
  signInHintKeys,
  summaryFromEvent,
} from "./downloadSummary.ts";
import { missingReleaseTracks } from "./missingTracks.ts";
import { classicModeForUrl, urlMatchesStudioDlMode } from "../youtubeUrl.ts";

test("il filtro tiene solo le righe d'errore, una volta sola", () => {
  const stderr = [
    "[download]  12.5% of 3.2MiB at 1MiB/s",
    "WARNING: [youtube] Falling back to generic n function search",
    "ERROR: [youtube] abc: Requested format is not available",
    "ERROR: [youtube] abc: Requested format is not available",
    "DeprecationWarning: something",
  ].join("\n");
  const out = ytdlpLogDetailForUser({ ok: false, stderr });
  assert.equal(out, "ERROR: [youtube] abc: Requested format is not available");
  assert.equal(ytdlpLogDetailForUser({ ok: true, stderr }), "");
});

test("i percorsi assoluti spariscono, gli URL restano", () => {
  const root = "/home/me/Musica";
  const s = redactPaths(
    "[download] Destination: /home/me/Musica/Artista/Album/01 - X.m4a from https://www.youtube.com/watch?v=abc",
    [root],
  );
  assert.equal(
    s,
    "[download] Destination: Artista/Album/01 - X.m4a from https://www.youtube.com/watch?v=abc",
  );
  assert.equal(redactPaths("file /opt/app/bin/yt-dlp"), "file …/yt-dlp");
  assert.equal(redactPaths("C:\\Users\\me\\Music\\a.m4a"), "…\\a.m4a");
});

test("problemi noti dal codice o dal log", () => {
  assert.equal(detectDownloadIssue("no_audio_format", ""), "no_audio_format");
  assert.equal(detectDownloadIssue(null, "ERROR: unable to download video data: HTTP Error 403: Forbidden"), "http_403");
  assert.equal(detectDownloadIssue("http_forbidden", ""), "http_403");
  assert.equal(detectDownloadIssue(null, "all good"), null);
});

test("riepilogo dai nuovi campi o dagli elenchi", () => {
  assert.deepEqual(
    summaryFromEvent({ downloaded: 3, skipped: 1, failed: 2, failedItems: [{ label: "a", reason: "x" }] }),
    { downloaded: 3, skipped: 1, failed: 2, skippedItems: [], failedItems: [{ label: "a", reason: "x" }] },
  );
  const s = summaryFromEvent({ downloadedItems: ["a", "b"], skippedItems: [{ label: "c", reason: "already downloaded" }] });
  assert.equal(s.downloaded, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
});

test("esito di un'uscita e conteggi del batch", () => {
  const sum = (d, f) => ({ downloaded: d, skipped: 0, failed: f, skippedItems: [], failedItems: [] });
  assert.equal(jobOutcome(true, false, sum(3, 0)), "ok");
  assert.equal(jobOutcome(true, false, sum(3, 1)), "partial");
  assert.equal(jobOutcome(false, false, sum(2, 5)), "partial");
  assert.equal(jobOutcome(false, false, sum(0, 5)), "failed");
  assert.equal(jobOutcome(false, true, sum(1, 0)), "cancelled");
  assert.deepEqual(batchCounts(["ok", "ok", "partial", "failed"]), { ok: 2, partial: 1, failed: 1, cancelled: 0 });
});

test("cartelle pianificate: già in libreria, ordinate, senza doppioni", () => {
  const rows = plannedReleaseFolders("Artista", ["Zeta", "Alfa", "Alfa"], ["Artista/zeta"]);
  assert.deepEqual(rows, [
    { path: "Artista/Alfa", exists: false },
    { path: "Artista/Zeta", exists: true },
  ]);
});

test("brani mancanti: confronto per titolo piegato, numerazione e feat. ignorati (issue #100)", () => {
  const release = [
    { title: "Intro", url: "u1" },
    { title: "Song Two (feat. Someone)", url: "u2" },
    { title: "Third Song", url: "u3" },
    { title: "Outro - Live", url: "u4" },
  ];
  const library = [
    { title: "01 - Intro", track_number: 1 },
    { title: "Song Two", track_number: 2 },
    { title: "Outro (Live)", track_number: 4 },
  ];
  assert.deepEqual(missingReleaseTracks(release, library), [{ index: 3, title: "Third Song", url: "u3" }]);
  assert.deepEqual(missingReleaseTracks(release, release.map((r) => ({ title: r.title }))), []);
  assert.equal(missingReleaseTracks(release, []).length, 4);
});

test("cartelle pianificate: la punteggiatura non conta (issue #100)", () => {
  // yt-dlp writes "?" as full-width "？"; a hand-made folder may drop it.
  const rows = plannedReleaseFolders(
    "Who?!",
    ["What?!", "Hey... (Live)", "Café Noir", "( )"],
    ["who！?/What？!", "Who?!/hey live", "who/cafe noir", "Who?!/( )"],
  );
  assert.deepEqual(
    rows.map((r) => [r.path, r.exists]),
    [
      ["Who?!/( )", true],
      ["Who?!/Café Noir", true],
      ["Who?!/Hey... (Live)", true],
      ["Who?!/What?!", true],
    ],
  );
  assert.equal(folderMatchKey("Who？!/What?!"), "who/what");
  assert.equal(folderMatchKey("Sigur Rós/( )"), "sigurros/( )");
});

test("riepilogo annidato in `summary` (hub nuovo)", () => {
  const s = summaryFromEvent({
    summary: { downloaded: 1, skipped: 0, failed: 11, total: 12 },
    failedItems: [{ label: "x", reason: "Requested format is not available", code: "no_audio_format" }],
  });
  assert.equal(s.downloaded, 1);
  assert.equal(s.failed, 11);
  assert.equal(s.failedItems.length, 1);
});

test("sign-in / age gate: riconosciuti da codice o log (cookie)", () => {
  assert.equal(detectDownloadIssue("sign_in_required", ""), "sign_in");
  assert.equal(detectDownloadIssue("age_restricted", ""), "sign_in");
  assert.equal(
    detectDownloadIssue("ytdlp_failed", "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies"),
    "sign_in",
  );
  assert.equal(
    detectDownloadIssue("ytdlp_failed", "ERROR: [youtube] jNQXAC9IVRw: The page needs to be reloaded."),
    "sign_in",
  );
  assert.equal(detectDownloadIssue(null, "ERROR: network unreachable"), null);
});

test("motore JavaScript di yt-dlp: etichetta e avviso solo se l'hub lo dichiara assente", () => {
  const qjs = pickJsRuntime({ available: true, name: "quickjs", version: "0.17.0", source: "bundled" });
  assert.equal(jsRuntimeLabel(qjs), "QuickJS 0.17.0");
  assert.equal(jsRuntimeMissing(qjs), false);
  assert.equal(jsRuntimeLabel(pickJsRuntime({ available: true, name: "node", version: null })), "Node.js");
  // Older hubs don't report it: no warning.
  assert.equal(jsRuntimeMissing(pickJsRuntime(undefined)), false);
  assert.equal(jsRuntimeMissing(pickJsRuntime({ available: false, name: null })), true);
  assert.equal(jsRuntimeMissing(pickJsRuntime({ available: false, disabled: true })), false);
});

test("un singolo di Scopri pubblicato come playlist apre il Classico in modalita' playlist", () => {
  const single = "https://music.youtube.com/playlist?list=OLAK5uy_nAFhlQYJNwnrEuIq2W-Uw34gN4yipEHsg";
  const mode = classicModeForUrl(single, "single");
  assert.equal(mode, "playlist");
  assert.equal(urlMatchesStudioDlMode(single, mode), true);
  assert.equal(classicModeForUrl("https://music.youtube.com/watch?v=jNQXAC9IVRw", "playlist"), "single");
  assert.equal(classicModeForUrl("not a link", "single"), "single");
});

test("con i cookie a posto e senza motore JS il suggerimento indica il motore, non i cookie", () => {
  assert.deepEqual(signInHintKeys(true, false), ["studio.dl.cookieHint"]);
  assert.deepEqual(signInHintKeys(false, false), ["studio.dl.cookieHint"]);
  assert.deepEqual(signInHintKeys(true, true), ["studio.dl.jsRuntimeHint"]);
  assert.deepEqual(signInHintKeys(false, true), ["studio.dl.cookieHint", "studio.dl.jsRuntimeHint"]);
});
