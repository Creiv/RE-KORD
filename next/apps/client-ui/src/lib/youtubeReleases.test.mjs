/**
 * Album o singolo: come si smistano le uscite trovate su YouTube, che arrivano
 * con titoli scritti in dieci modi diversi e a volte senza conteggio brani.
 * Si lancia con `pnpm test` (node --experimental-strip-types).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyYoutubeReleaseEntry,
  partitionYoutubeReleaseEntries,
} from "./youtubeReleases.ts";

const entry = (over) => ({ title: "Senza nome", url: "", trackCount: null, ...over });

test("il tipo scritto in testa al titolo comanda", () => {
  const kind = (title) => classifyYoutubeReleaseEntry(entry({ title }));
  assert.equal(kind("Album • Bangarang EP"), "album");
  assert.equal(kind("EP · Recess"), "album");
  assert.equal(kind("Single • Rock n' Roll"), "song");
  assert.equal(kind("Singolo - Ragazzo fortunato"), "song");
  assert.equal(kind("Video | Kyoto"), "song");
});

test("il tipo scritto in coda vale come quello in testa", () => {
  assert.equal(classifyYoutubeReleaseEntry(entry({ title: "Bangarang - Single" })), "song");
  assert.equal(classifyYoutubeReleaseEntry(entry({ title: "Kyoto – Video" })), "song");
});

test("il tipo scritto batte anche il conteggio brani", () => {
  const kind = classifyYoutubeReleaseEntry(
    entry({ title: "Single • Rock n' Roll", trackCount: 4 }),
  );
  assert.equal(kind, "song");
});

test("senza tipo scritto conta quanti brani ci sono", () => {
  assert.equal(classifyYoutubeReleaseEntry(entry({ title: "Bangarang", trackCount: 1 })), "song");
  assert.equal(classifyYoutubeReleaseEntry(entry({ title: "Bangarang", trackCount: 9 })), "album");
});

test("senza conteggio parla l'indirizzo", () => {
  const kind = (url) => classifyYoutubeReleaseEntry(entry({ title: "Bangarang", url }));
  assert.equal(kind("https://www.youtube.com/watch?v=YJVmu6yttiw"), "song");
  assert.equal(kind("https://youtu.be/YJVmu6yttiw"), "song");
  // Un video dentro una playlist e' la playlist che interessa, non il video.
  assert.equal(kind("https://www.youtube.com/watch?v=YJVmu6yttiw&list=PL123"), "album");
  assert.equal(kind("https://www.youtube.com/playlist?list=OLAK5uy_123"), "album");
});

test("le playlist RD sono radio generate: un brano, non un disco", () => {
  const kind = classifyYoutubeReleaseEntry(
    entry({ title: "Bangarang", url: "https://www.youtube.com/playlist?list=RDAMVM123" }),
  );
  assert.equal(kind, "song");
});

test("titolo generico e indirizzo illeggibile: si tratta come album", () => {
  assert.equal(classifyYoutubeReleaseEntry(entry({ title: "Bangarang" })), "album");
  assert.equal(
    classifyYoutubeReleaseEntry(entry({ title: "Bangarang", url: "non un indirizzo" })),
    "album",
  );
});

test("smistando non si perde niente e l'ordine resta", () => {
  const entries = [
    entry({ title: "Album • Recess" }),
    entry({ title: "Single • Rock n' Roll" }),
    entry({ title: "Bangarang", trackCount: 12 }),
    entry({ title: "Kyoto", url: "https://youtu.be/abc" }),
  ];
  const { albums, songs } = partitionYoutubeReleaseEntries(entries);
  assert.deepEqual(albums.map((e) => e.title), ["Album • Recess", "Bangarang"]);
  assert.deepEqual(songs.map((e) => e.title), ["Single • Rock n' Roll", "Kyoto"]);
  assert.equal(albums.length + songs.length, entries.length);
});
