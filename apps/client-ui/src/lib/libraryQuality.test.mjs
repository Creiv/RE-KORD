/**
 * "Alert qualità" / "Da sistemare": stesse regole dell'hub (`db::quality`),
 * contate solo sul catalogo dell'account (la sua selezione di libreria).
 * Si lancia con `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  albumMissingMeta,
  countOf,
  qualityCountsOf,
  qualityLists,
  qualityTotal,
  trackMissingMeta,
} from "./libraryQuality.ts";
import { trackHasFileMeta } from "./trackMoods.ts";

const album = (id, over = {}) => ({
  id,
  name: `Album ${id}`,
  artist_name: over.artist_name ?? "Artist",
  track_count: 1,
  artist_id: 1,
  folder_key: `Artist/Album ${id}`,
  has_cover: false,
  loose: false,
  ...over,
});

const track = (id, album_id, over = {}) => ({
  id,
  rel_path: `t${id}.mp3`,
  title: `Track ${id}`,
  artist_name: "Artist",
  album_name: `Album ${album_id}`,
  album_id,
  artist_id: 1,
  track_number: id,
  duration_ms: 1000,
  genre: null,
  release_date: null,
  ...over,
});

test("brano senza metadati: niente genere vero e niente data", () => {
  assert.equal(trackHasFileMeta(track(1, 1)), false);
  assert.equal(trackHasFileMeta(track(1, 1, { genre: "  " })), false);
  // Segnaposto e numeri non sono generi (come `split_genres` dell'hub).
  assert.equal(trackHasFileMeta(track(1, 1, { genre: "Unknown" })), false);
  assert.equal(trackHasFileMeta(track(1, 1, { genre: "8; (17); Music" })), false);
  assert.equal(trackHasFileMeta(track(1, 1, { genre: "Rock" })), true);
  assert.equal(trackHasFileMeta(track(1, 1, { release_date: "2020" })), true);
  assert.equal(trackHasFileMeta(track(1, 1, { release_date: "  " })), false);
  assert.equal(trackMissingMeta(track(1, 1, { genre: "Unknown" })), true);
});

test("album senza metadati: né flag né data, etichetta o paese; le cartelle sfuse no", () => {
  assert.equal(albumMissingMeta(album(1)), true);
  assert.equal(albumMissingMeta(album(1, { has_album_meta: true })), false);
  assert.equal(albumMissingMeta(album(1, { release_date: "1976" })), false);
  assert.equal(albumMissingMeta(album(1, { label: "Swan Song" })), false);
  assert.equal(albumMissingMeta(album(1, { country: "UK" })), false);
  assert.equal(albumMissingMeta(album(1, { loose: true })), false);
});

test("si conta solo la selezione dell'account: album fuori dal catalogo non entrano", () => {
  const albums = [
    album(1),
    album(2, { has_cover: true, has_album_meta: true }),
    album(3, { loose: true }),
    album(4), // non nel catalogo di questo account
  ];
  const catalog = [
    track(1, 1),
    track(2, 1, { genre: "Rock" }),
    track(3, 2, { genre: "Unknown" }),
    track(4, 3, { release_date: "2001" }),
  ];
  const c = qualityCountsOf(albums, catalog);
  assert.deepEqual(c, { albumsWithoutCover: 1, albumsWithoutMeta: 1, tracksWithoutMeta: 2, looseAlbums: 1 });
  assert.equal(qualityTotal(c), 4);
  const lists = qualityLists(albums, catalog, "it");
  for (const issue of ["albums-without-cover", "albums-without-meta", "tracks-without-meta", "loose-albums"]) {
    assert.equal(lists[issue].length, countOf(c, issue), issue);
  }
  assert.deepEqual(lists["albums-without-cover"].map((a) => a.id), [1]);
  assert.deepEqual(lists["tracks-without-meta"].map((t) => t.id), [1, 3]);
  assert.deepEqual(lists["loose-albums"].map((a) => a.id), [3]);
});

test("le liste sono ordinate per artista, album e numero di traccia", () => {
  const albums = [album(1, { artist_name: "Zed" }), album(2, { artist_name: "abba" })];
  const catalog = [
    track(5, 1, { artist_name: "Zed", track_number: 2 }),
    track(6, 1, { artist_name: "Zed", track_number: 1 }),
    track(7, 2, { artist_name: "abba", track_number: 9 }),
  ];
  const lists = qualityLists(albums, catalog, "it");
  assert.deepEqual(lists["albums-without-cover"].map((a) => a.id), [2, 1]);
  assert.deepEqual(lists["tracks-without-meta"].map((t) => t.id), [7, 6, 5]);
});

test("una modifica locale al genere conta subito (si legge `genre`, non `genres`)", () => {
  const before = track(1, 1, { genres: [] });
  assert.equal(trackMissingMeta(before), true);
  assert.equal(trackMissingMeta({ ...before, genre: "Jazz" }), false);
});
