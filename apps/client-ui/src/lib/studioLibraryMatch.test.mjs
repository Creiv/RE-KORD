/** Studio "In libreria" matching (lib/studio/libraryMatch.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artistFromSubtitle,
  buildLibraryIndex,
  libraryHitFor,
  matchLibraryAlbum,
  matchLibrarySong,
  normalizeReleaseTitle,
  splitArtists,
} from "./studio/libraryMatch.ts";

const albums = [
  { name: "From Zero： A Cappellas", artist_name: "Linkin Park", folder_key: "Linkin Park/From Zero： A Cappellas" },
  { name: "Minutes to Midnight", artist_name: "Linkin Park", folder_key: "Linkin Park/Minutes to Midnight" },
  { name: "Exuvia", artist_name: "Caparezza", folder_key: "Caparezza/Exuvia" },
  { name: "Verità Supposte", artist_name: "Caparezza", folder_key: "Caparezza/Verità Supposte" },
  { name: "Desperado (2013 Remaster)", artist_name: "Eagles", folder_key: "Eagles/Desperado" },
  { name: "Bridge Over Troubled Water", artist_name: "Simon & Garfunkel", folder_key: "S&G/Bridge" },
];
const tracks = [
  { title: "02 - The Emptiness Machine", artist_name: "Linkin Park" },
  { title: "Canthology", artist_name: "Caparezza" },
  { title: "Fuori dal tunnel (feat. Someone)", artist_name: "Caparezza" },
];
const idx = buildLibraryIndex(albums, tracks);

test("titoli: suffissi di edizione, featuring e punteggiatura", () => {
  const base = normalizeReleaseTitle("Minutes to Midnight");
  for (const t of [
    "Minutes To Midnight (Deluxe Edition)",
    "Minutes to Midnight [Remastered 2017]",
    "Minutes to Midnight - Deluxe",
    "MINUTES TO MIDNIGHT (Expanded)",
    "Minutes to Midnight - EP",
    "Minutes to Midnight – Single",
    "Minutes to Midnight (feat. Someone)",
    "Minutes to Midnight feat. Someone",
    "Minutes-to-Midnight!",
  ]) {
    assert.equal(normalizeReleaseTitle(t), base, t);
  }
  // Fullwidth colon of a Windows-safe folder name and the plain one agree.
  assert.equal(normalizeReleaseTitle("From Zero： A Cappellas"), normalizeReleaseTitle("From Zero: A Cappellas"));
  // Different versions stay different.
  assert.notEqual(normalizeReleaseTitle("Numb (Live)"), normalizeReleaseTitle("Numb"));
  assert.notEqual(normalizeReleaseTitle("Numb (Acoustic Version)"), normalizeReleaseTitle("Numb"));
  // An Italian "con" inside a title is not a featuring.
  assert.equal(normalizeReleaseTitle("Ballo con te"), "ballo con te");
  // A title made only of noise is kept rather than emptied.
  assert.ok(normalizeReleaseTitle("(Deluxe)").length > 0);
  assert.equal(normalizeReleaseTitle("01 - Canthology"), "canthology");
});

test("accenti e maiuscole non contano", () => {
  assert.equal(normalizeReleaseTitle("VERITÀ SUPPOSTE"), normalizeReleaseTitle("Verita Supposte"));
  assert.equal(matchLibraryAlbum(idx, "caparezza", "Verita' Supposte"), "Caparezza/Verità Supposte");
});

test("artisti: elenchi, featuring, 'The', alias congiunti", () => {
  assert.deepEqual(splitArtists("SLVSHY, CLE4VER e DJ BEATCOIN").slice(1), ["slvshy", "cle4ver", "dj beatcoin"]);
  assert.ok(splitArtists("MADE e ISO").includes("iso"));
  assert.ok(splitArtists("The Beatles").includes("beatles"));
  assert.ok(splitArtists("Linkin Park feat. Jay-Z").includes("jay z"));
  assert.ok(splitArtists("Simon & Garfunkel").includes("simon and garfunkel"));
  assert.ok(splitArtists("Simon and Garfunkel").includes("simon and garfunkel"));
  assert.deepEqual(splitArtists(""), []);
});

test("sottotitolo YouTube Music → artista", () => {
  assert.equal(artistFromSubtitle("Album • Linkin Park • 2007"), "Linkin Park");
  assert.equal(artistFromSubtitle("Singolo • MADE e ISO"), "MADE e ISO");
  assert.equal(artistFromSubtitle("Brano · Caparezza"), "Caparezza");
  assert.equal(artistFromSubtitle("Linkin Park"), "");
  assert.equal(artistFromSubtitle(""), "");
});

test("album in libreria: match per titolo + artista", () => {
  assert.equal(matchLibraryAlbum(idx, "Linkin Park", "From Zero: A Cappellas"), "Linkin Park/From Zero： A Cappellas");
  assert.equal(matchLibraryAlbum(idx, "Linkin Park", "Minutes to Midnight (Deluxe Edition)"), "Linkin Park/Minutes to Midnight");
  assert.equal(matchLibraryAlbum(idx, "Eagles", "Desperado"), "Eagles/Desperado");
  assert.equal(matchLibraryAlbum(idx, "Simon and Garfunkel", "Bridge over Troubled Water"), "S&G/Bridge");
  // Same title, other artist: not ours.
  assert.equal(matchLibraryAlbum(idx, "Someone Else", "Exuvia"), null);
  assert.equal(matchLibraryAlbum(idx, "", "Exuvia"), null);
  assert.equal(matchLibraryAlbum(idx, "Linkin Park", "Meteora"), null);
});

test("brani in libreria: titolo + artista", () => {
  assert.equal(matchLibrarySong(idx, "Linkin Park", "The Emptiness Machine"), true);
  assert.equal(matchLibrarySong(idx, "Caparezza", "Fuori dal tunnel"), true);
  assert.equal(matchLibrarySong(idx, "Linkin Park", "Numb"), false);
  assert.equal(matchLibrarySong(idx, "Other", "Canthology"), false);
});

test("libraryHitFor usa il sottotitolo e distingue album e brani", () => {
  assert.deepEqual(libraryHitFor(idx, { kind: "album", title: "Minutes to Midnight", subtitle: "Album • Linkin Park • 2007" }), {
    kind: "album",
    folder: "Linkin Park/Minutes to Midnight",
  });
  assert.deepEqual(libraryHitFor(idx, { kind: "song", title: "The Emptiness Machine", subtitle: "Brano • Linkin Park" }), {
    kind: "song",
  });
  // A single titled like an album of the library is not the album.
  assert.equal(libraryHitFor(idx, { kind: "song", title: "Exuvia", subtitle: "Singolo • Caparezza" }), null);
  assert.equal(libraryHitFor(idx, { kind: "album", title: "Exuvia", artist: "Caparezza" })?.kind, "album");
  assert.equal(libraryHitFor(idx, { kind: "album", title: "Exuvia", subtitle: "" }), null);
});
