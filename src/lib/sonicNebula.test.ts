import { describe, expect, it } from "vitest";
import {
  buildNebulaModel,
  filterNebulaStars,
  nebulaStarsNear,
  pickNebulaStarAt,
  buildNebulaSpatialGrid,
  sampleNebulaStarsForPreview,
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

  it("filters by query", () => {
    const model = buildNebulaModel(
      [
        track("1.mp3", "Energy", ["energy_boost"]),
        track("2.mp3", "Chill", ["chill_relax"]),
      ],
      { playCounts: {}, favorites: new Set() }
    );
    const all = filterNebulaStars(model.stars, "");
    expect(all).toHaveLength(2);

    const query = filterNebulaStars(model.stars, "chill");
    expect(query).toHaveLength(1);
    expect(query[0]?.track.title).toBe("Chill");
  });

  it("covers the galaxy disk without large angular gaps", () => {
    const tracks = Array.from({ length: 240 }, (_, i) =>
      track(
        `t${i}.mp3`,
        `T${i}`,
        i % 3 === 0
          ? ["dark_tense"]
          : i % 3 === 1
            ? ["chill_relax"]
            : ["energy_boost"]
      )
    );
    const model = buildNebulaModel(tracks, {
      playCounts: {},
      favorites: new Set(),
    });
    const sectors = Array(8).fill(0);
    const radii: number[] = [];
    for (const star of model.stars) {
      const dx = star.x - 1100;
      const dy = star.y - 1100;
      let angle = Math.atan2(dy, dx);
      angle = (angle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      sectors[Math.floor(angle / (Math.PI / 4)) % 8] += 1;
      radii.push(Math.hypot(dx, dy) / 968);
    }
    const minSector = Math.min(...sectors);
    const maxSector = Math.max(...sectors);
    expect(minSector).toBeGreaterThan(maxSector * 0.18);
    expect(radii.some((r) => r < 0.2)).toBe(true);
    expect(radii.some((r) => r > 0.82)).toBe(true);
  });

  it("samples preview stars across the disk", () => {
    const model = buildNebulaModel(
      Array.from({ length: 120 }, (_, i) => track(`t${i}.mp3`, `T${i}`)),
      { playCounts: {}, favorites: new Set() }
    );
    const sample = sampleNebulaStarsForPreview(model.stars, 48);
    expect(sample.length).toBe(48);

    const cx = 1100;
    const cy = 1100;
    const oct = Array(8).fill(0);
    for (const star of sample) {
      let a = Math.atan2(star.y - cy, star.x - cx);
      a = (Math.PI / 2 - a + Math.PI * 8) % (Math.PI * 2);
      oct[Math.floor(a / (Math.PI / 4)) % 8] += 1;
    }
    const minOct = Math.min(...oct);
    const maxOct = Math.max(...oct);
    expect(minOct).toBeGreaterThan(0);
    expect(minOct).toBeGreaterThan(maxOct * 0.25);
  });

  it("finds nearby stars and hit targets", () => {
    const model = buildNebulaModel(
      Array.from({ length: 12 }, (_, i) => track(`t${i}.mp3`, `T${i}`)),
      { playCounts: {}, favorites: new Set() }
    );
    const center = model.stars[0]!;
    const near = nebulaStarsNear(model.stars, center, 320, 5);
    expect(near.length).toBeGreaterThan(0);

    const grid = buildNebulaSpatialGrid(model.stars);
    const hit = pickNebulaStarAt(grid, center.x, center.y, 1);
    expect(hit?.id).toBe(center.id);
  });
});
