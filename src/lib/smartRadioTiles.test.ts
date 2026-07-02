import { describe, expect, it } from "vitest";
import {
  buildSmartRadioCandidatePool,
  pickSmartRadioDisplayTracks,
  smartRadioAlbumKey,
} from "./smartRadioTiles";
import type { EnrichedTrack } from "../types";

function tr(relPath: string, albumId = relPath): EnrichedTrack {
  return {
    id: relPath,
    relPath,
    title: relPath,
    artist: "A",
    album: `Al-${albumId}`,
    albumId,
  };
}

describe("buildSmartRadioCandidatePool", () => {
  it("include ultimi 2 recenti e preferiti senza duplicati", () => {
    const pool = buildSmartRadioCandidatePool(
      [tr("r1"), tr("r2"), tr("r3")],
      [tr("f1"), tr("r2")],
    );
    expect(pool.map((t) => t.relPath)).toEqual(["r1", "r2", "f1"]);
  });
});

describe("pickSmartRadioDisplayTracks", () => {
  it("lascia un posto per il tasto Random", () => {
    const pool = Array.from({ length: 12 }, (_, i) => tr(`t${i}`));
    const out = pickSmartRadioDisplayTracks(pool, 9);
    expect(out.length).toBe(8);
  });

  it("non supera la dimensione del pool", () => {
    const pool = [tr("a"), tr("b")];
    const out = pickSmartRadioDisplayTracks(pool, 8);
    expect(out.length).toBe(2);
  });

  it("preferisce album diversi quando gli slot bastano", () => {
    const pool = [
      tr("a1", "album-1"),
      tr("a2", "album-1"),
      tr("b1", "album-2"),
      tr("c1", "album-3"),
    ];
    // 3 slot brano e 3 album unici: nessun doppione dello stesso album.
    const out = pickSmartRadioDisplayTracks(pool, 4);
    const albums = out.map(smartRadioAlbumKey);
    expect(new Set(albums).size).toBe(albums.length);
    expect(out.length).toBe(3);
  });

  it("riempie gli slot residui se gli album unici non bastano", () => {
    const pool = [
      tr("a1", "album-1"),
      tr("a2", "album-1"),
      tr("b1", "album-2"),
      tr("c1", "album-3"),
    ];
    // 7 slot brano ma solo 3 album: il vincolo si rilassa, niente slot vuoti.
    const out = pickSmartRadioDisplayTracks(pool, 8);
    expect(out.length).toBe(4);
    expect(new Set(out.map((t) => t.relPath)).size).toBe(4);
    const albums = new Set(out.map(smartRadioAlbumKey));
    expect(albums.size).toBe(3);
  });

  it("riempie dalla libreria se il pool non basta", () => {
    const pool = [tr("a", "album-a")];
    const library = [
      tr("a", "album-a"),
      tr("b", "album-b"),
      tr("c", "album-c"),
      tr("d", "album-d"),
    ];
    const out = pickSmartRadioDisplayTracks(pool, 5, library);
    expect(out.length).toBe(4);
    const albums = out.map(smartRadioAlbumKey);
    expect(new Set(albums).size).toBe(albums.length);
  });
});
