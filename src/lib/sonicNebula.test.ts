import { describe, expect, it } from "vitest";
import {
  buildNebulaModel,
  filterNebulaStars,
  nebulaStarsNear,
  pickNebulaStarAt,
  buildNebulaSpatialGrid,
} from "./sonicNebula";
import type { EnrichedTrack } from "../types";

function track(
  relPath: string,
  title: string,
  moods?: string[]
): EnrichedTrack {
  return {
    id: relPath,
    relPath,
    title,
    artist: "Artist",
    album: "Album",
    meta: moods ? { moods, fileName: `${title}.mp3`, size: null, mtime: null, releaseDate: null, genre: null, durationMs: 200_000, trackNumber: null, discNumber: null, source: null, url: null } : { fileName: `${title}.mp3`, size: null, mtime: null, releaseDate: null, genre: "Rock", durationMs: 200_000, trackNumber: null, discNumber: null, source: null, url: null },
  };
}

describe("sonicNebula", () => {
  it("builds stable star positions", () => {
    const tracks = [track("a.mp3", "Alpha"), track("b.mp3", "Beta")];
    const a = buildNebulaModel(tracks, { playCounts: {}, favorites: new Set() });
    const b = buildNebulaModel(tracks, { playCounts: {}, favorites: new Set() });
    expect(a.stars[0]?.x).toBe(b.stars[0]?.x);
    expect(a.stars[1]?.y).toBe(b.stars[1]?.y);
  });

  it("boosts radius for favorites and play counts", () => {
    const tracks = [track("fav.mp3", "Fav")];
    const plain = buildNebulaModel(tracks, { playCounts: {}, favorites: new Set() });
    const rich = buildNebulaModel(tracks, {
      playCounts: { "fav.mp3": 32 },
      favorites: new Set(["fav.mp3"]),
    });
    expect(rich.stars[0]!.radius).toBeGreaterThan(plain.stars[0]!.radius);
  });

  it("filters by mood and query", () => {
    const model = buildNebulaModel(
      [
        track("1.mp3", "Energy", ["energy_boost"]),
        track("2.mp3", "Chill", ["chill_relax"]),
      ],
      { playCounts: {}, favorites: new Set() }
    );
    const moodOnly = filterNebulaStars(model.stars, "energy_boost", "");
    expect(moodOnly).toHaveLength(1);
    expect(moodOnly[0]?.track.title).toBe("Energy");

    const query = filterNebulaStars(model.stars, null, "chill");
    expect(query).toHaveLength(1);
    expect(query[0]?.track.title).toBe("Chill");
  });

  it("finds nearby stars and hit targets", () => {
    const model = buildNebulaModel(
      Array.from({ length: 12 }, (_, i) => track(`t${i}.mp3`, `T${i}`)),
      { playCounts: {}, favorites: new Set() }
    );
    const center = model.stars[0]!;
    const near = nebulaStarsNear(model.stars, center, 120, 5);
    expect(near.length).toBeGreaterThan(0);

    const grid = buildNebulaSpatialGrid(model.stars);
    const hit = pickNebulaStarAt(grid, center.x, center.y, 1);
    expect(hit?.id).toBe(center.id);
  });
});
