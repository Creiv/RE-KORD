import { describe, expect, it } from "vitest";
import {
  eligibleTracksForIntelligentRandom,
  isTrackShuffleExcluded,
} from "./randomExclusions";
import type { LibraryIndex } from "../types";

const index = {
  tracks: [
    {
      relPath: "Artist/Tracks/a.mp3",
      artist: "Artist",
      album: "Tracks",
      albumId: "Artist::Tracks",
    },
    {
      relPath: "Artist/Tracks/b.mp3",
      artist: "Artist",
      album: "Tracks",
      albumId: "Artist::Tracks",
    },
  ],
} as unknown as LibraryIndex;

describe("randomExclusions", () => {
  it("isTrackShuffleExcluded matches legacy Tracce exclusion path", () => {
    const excluded = new Set(["Artist/Tracce/a.mp3"]);
    expect(
      isTrackShuffleExcluded(index.tracks[0]!, excluded, new Set()),
    ).toBe(true);
    expect(
      isTrackShuffleExcluded(index.tracks[1]!, excluded, new Set()),
    ).toBe(false);
  });

  it("eligibleTracksForIntelligentRandom honors legacy exclusion keys", () => {
    const excluded = new Set(["Artist/Tracce/a.mp3"]);
    const eligible = eligibleTracksForIntelligentRandom(
      index,
      new Set(),
      excluded,
    );
    expect(eligible.map((t) => t.relPath)).toEqual(["Artist/Tracks/b.mp3"]);
  });
});
