import { describe, expect, it } from "vitest";
import {
  buildCardPlayQueueFromSeed,
  buildSmartRandomQueue,
  seedSimilarityScore,
} from "./smartShuffle";
import type { EnrichedTrack } from "../types";

function tr(relPath: string, artist: string): EnrichedTrack {
  return {
    id: relPath,
    title: relPath,
    relPath,
    artist,
    album: "Al",
  };
}

describe("buildSmartRandomQueue", () => {
  it("mette i brani non recenti prima di quelli in recent", () => {
    const a = tr("a", "A");
    const b = tr("b", "B");
    const out = buildSmartRandomQueue([a, b], {
      recentRelPaths: new Set(["a"]),
    });
    expect(out[0].relPath).toBe("b");
  });

  it("restituisce [] su lista vuota", () => {
    expect(buildSmartRandomQueue([])).toEqual([]);
  });
});

describe("buildCardPlayQueueFromSeed", () => {
  function tr(
    relPath: string,
    artist: string,
    opts?: {
      moods?: string[];
      genre?: string | null;
    },
  ): EnrichedTrack {
    return {
      id: relPath,
      title: relPath,
      relPath,
      artist,
      album: "Al",
      meta: opts
        ? {
            fileName: relPath,
            size: null,
            mtime: null,
            releaseDate: null,
            genre: opts.genre ?? null,
            moods:
              opts.moods && opts.moods.length ? [...opts.moods] : undefined,
            durationMs: null,
            trackNumber: null,
            discNumber: null,
            source: null,
            url: null,
          }
        : undefined,
    };
  }

  it("mood e genere a pari peso: match doppio > match singolo > solo artista > resto", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const both = tr("both1", "Bravo", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const moodOnly = tr("mood1", "Other", { moods: ["energy_boost"], genre: "Jazz" });
    const artistOnly = tr("artist1", "Alpha", {
      moods: [],
      genre: "Classical",
    });
    const rest = tr("rest1", "Zeta", {
      moods: [],
      genre: "Pop",
    });
    const lib = [seed, moodOnly, both, artistOnly, rest];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    expect(q[0].relPath).toBe("seed");
    const iBoth = q.findIndex((t) => t.relPath === "both1");
    const iMood = q.findIndex((t) => t.relPath === "mood1");
    const iArtist = q.findIndex((t) => t.relPath === "artist1");
    const iRest = q.findIndex((t) => t.relPath === "rest1");
    expect(iBoth).toBeLessThan(iMood);
    expect(iMood).toBeLessThan(iArtist);
    expect(iArtist).toBeLessThan(iRest);
  });

  it("mood e genere hanno lo stesso peso a parità di overlap", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const moodOnly = tr("mood1", "Other", {
      moods: ["energy_boost"],
      genre: "Jazz",
    });
    const genreOnly = tr("genre1", "Other", { moods: [], genre: "Rock" });
    expect(seedSimilarityScore(seed, moodOnly)).toBe(
      seedSimilarityScore(seed, genreOnly),
    );
  });

  it("con seed a 2+ mood mette prima i match forti (2+) poi quelli con 1 solo", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost", "party_dance"],
      genre: "Rock",
    });
    const moodStrong = tr("strong", "Other", {
      moods: ["energy_boost", "party_dance"],
      genre: "Jazz",
    });
    const moodWeak = tr("weak", "Other", {
      moods: ["energy_boost"],
      genre: "Jazz",
    });
    const lib = [seed, moodWeak, moodStrong];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    const iStrong = q.findIndex((t) => t.relPath === "strong");
    const iWeak = q.findIndex((t) => t.relPath === "weak");
    expect(iStrong).toBeLessThan(iWeak);
  });

  it("radio con respectExclusions false include brani bloccati", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const blocked = tr("blocked", "Other", {
      moods: ["energy_boost"],
      genre: "Jazz",
    });
    const lib = [seed, blocked];
    const q = buildCardPlayQueueFromSeed(seed, lib, {
      respectExclusions: false,
      excludedTracks: new Set(["blocked"]),
      excludedAlbums: new Set(),
    });
    expect(q.map((t) => t.relPath)).toContain("blocked");
  });

  it("radio con respectExclusions true esclude brani bloccati", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const blocked = tr("blocked", "Other", {
      moods: ["energy_boost"],
      genre: "Jazz",
    });
    const lib = [seed, blocked];
    const q = buildCardPlayQueueFromSeed(seed, lib, {
      respectExclusions: true,
      excludedTracks: new Set(["blocked"]),
      excludedAlbums: new Set(),
    });
    expect(q.map((t) => t.relPath)).not.toContain("blocked");
  });

  it("radio da seed bloccato: i bloccati restano ammessi in coda", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const blocked = tr("blocked", "Other", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const lib = [seed, blocked];
    const q = buildCardPlayQueueFromSeed(seed, lib, {
      respectExclusions: true,
      excludedTracks: new Set(["seed", "blocked"]),
      excludedAlbums: new Set(),
    });
    expect(q[0].relPath).toBe("seed");
    expect(q.map((t) => t.relPath)).toContain("blocked");
  });

  it("radio mette i riprodotti di recente in fondo alla coda", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const recentMatch = tr("recent1", "Other", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const freshWeak = tr("fresh1", "Zeta", { moods: [], genre: "Pop" });
    const lib = [seed, recentMatch, freshWeak];
    const q = buildCardPlayQueueFromSeed(seed, lib, {
      recentRelPaths: new Set(["recent1"]),
    });
    const iRecent = q.findIndex((t) => t.relPath === "recent1");
    const iFresh = q.findIndex((t) => t.relPath === "fresh1");
    expect(iFresh).toBeLessThan(iRecent);
  });

  it("radio evita lo stesso artista di fila quando possibile", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const sameA1 = tr("a1", "Beta", { moods: ["energy_boost"], genre: "Rock" });
    const sameA2 = tr("a2", "Beta", { moods: ["energy_boost"], genre: "Rock" });
    const other = tr("b1", "Gamma", { moods: [], genre: "Pop" });
    const lib = [seed, sameA1, sameA2, other];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    for (let i = 0; i < q.length - 1; i += 1) {
      expect(q[i].artist).not.toBe(q[i + 1].artist);
    }
  });

  it("seed senza mood: generi con più overlap in comune rankano più in alto", () => {
    const seed = tr("seed", "Alpha", {
      moods: [],
      genre: "Rock; Alternative; Indie",
    });
    const genreStrong = tr("genreStrong", "Other", {
      moods: ["energy_boost"],
      genre: "Rock; Alternative; Indie",
    });
    const genreWeak = tr("genreWeak", "Other", {
      moods: ["chill_relax"],
      genre: "Rock",
    });
    const artistOnly = tr("artist1", "Alpha", {
      moods: [],
      genre: "Classical",
    });
    const lib = [seed, genreWeak, genreStrong, artistOnly];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    const iStrong = q.findIndex((t) => t.relPath === "genreStrong");
    const iWeak = q.findIndex((t) => t.relPath === "genreWeak");
    expect(iStrong).toBeLessThan(iWeak);
    expect(seedSimilarityScore(seed, genreWeak)).toBeGreaterThan(
      seedSimilarityScore(seed, artistOnly),
    );
  });

  it("seed senza mood né genere: stesso artista ranka sopra il resto", () => {
    const seed = tr("seed", "Alpha", { moods: [], genre: null });
    const sameArtist = tr("artist1", "Alpha", { moods: [], genre: "Pop" });
    const other = tr("other", "Zeta", { moods: [], genre: "Pop" });
    expect(seedSimilarityScore(seed, sameArtist)).toBeGreaterThan(
      seedSimilarityScore(seed, other),
    );
  });

  it("seedSimilarityScore: 1 genere su 3 pesa meno di 3 su 3", () => {
    const seed = tr("seed", "Alpha", {
      moods: [],
      genre: "Rock; Alternative; Indie",
    });
    const weak = tr("weak", "Other", { moods: [], genre: "Rock" });
    const strong = tr("strong", "Other", {
      moods: [],
      genre: "Rock; Alternative; Indie",
    });
    expect(seedSimilarityScore(seed, strong)).toBeGreaterThan(
      seedSimilarityScore(seed, weak),
    );
    // Stesso artista senza genere in comune resta sotto un match genere debole.
    const sameArtist = tr("artist1", "Alpha", { moods: [], genre: "Classical" });
    expect(seedSimilarityScore(seed, weak)).toBeGreaterThan(
      seedSimilarityScore(seed, sameArtist),
    );
  });
});
