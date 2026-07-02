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

  it("priorità mood poi genere poi artista poi resto (blocchi consecutivi)", () => {
    const seed = tr("seed", "Alpha", {
      moods: ["energy_boost"],
      genre: "Rock",
    });
    const moodOnly = tr("mood1", "Other", { moods: ["energy_boost"], genre: "Jazz" });
    const genreOnly = tr("genre1", "Other", {
      moods: [],
      genre: "Rock",
    });
    const artistOnly = tr("artist1", "Alpha", {
      moods: [],
      genre: "Classical",
    });
    const rest = tr("rest1", "Zeta", {
      moods: [],
      genre: "Pop",
    });
    const lib = [seed, moodOnly, genreOnly, artistOnly, rest];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    expect(q[0].relPath).toBe("seed");
    const iMood = q.findIndex((t) => t.relPath === "mood1");
    const iGenre = q.findIndex((t) => t.relPath === "genre1");
    const iArtist = q.findIndex((t) => t.relPath === "artist1");
    const iRest = q.findIndex((t) => t.relPath === "rest1");
    expect(iMood).toBeLessThan(iGenre);
    expect(iGenre).toBeLessThan(iArtist);
    expect(iArtist).toBeLessThan(iRest);
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
    const genreOnly = tr("genre1", "Other", {
      moods: [],
      genre: "Rock",
    });
    const lib = [seed, moodWeak, moodStrong, genreOnly];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    const iStrong = q.findIndex((t) => t.relPath === "strong");
    const iWeak = q.findIndex((t) => t.relPath === "weak");
    const iGenre = q.findIndex((t) => t.relPath === "genre1");
    expect(iStrong).toBeLessThan(iWeak);
    expect(iWeak).toBeLessThan(iGenre);
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
    const iArtist = q.findIndex((t) => t.relPath === "artist1");
    expect(iStrong).toBeLessThan(iWeak);
    expect(iWeak).toBeLessThan(iArtist);
  });

  it("seed senza mood né genere: stesso artista prima del resto", () => {
    const seed = tr("seed", "Alpha", { moods: [], genre: null });
    const sameArtist = tr("artist1", "Alpha", { moods: [], genre: "Pop" });
    const other = tr("other", "Zeta", { moods: [], genre: "Pop" });
    const lib = [seed, other, sameArtist];
    const q = buildCardPlayQueueFromSeed(seed, lib);
    const iArtist = q.findIndex((t) => t.relPath === "artist1");
    const iOther = q.findIndex((t) => t.relPath === "other");
    expect(iArtist).toBeLessThan(iOther);
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
