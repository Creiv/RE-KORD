// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("./db/index.mjs", () => ({
  getLibraryEpoch: vi.fn(() => 5),
}));

import {
  buildLibraryDelta,
  recordLibraryDelta,
  resetLibraryDeltaJournalForTests,
} from "./libraryDelta.mjs";

describe("libraryDelta", () => {
  it("restituisce unchanged se epoch uguale", () => {
    resetLibraryDeltaJournalForTests();
    const delta = buildLibraryDelta("/music", 5);
    expect(delta.changed).toBe(false);
    expect(delta.indexEpoch).toBe(5);
  });

  it("merge journal entries dopo sinceEpoch", () => {
    resetLibraryDeltaJournalForTests();
    const root = "/music";
    recordLibraryDelta(root, {
      epoch: 4,
      removedTrackPaths: ["a/old.mp3"],
      addedTrackPaths: ["a/new.mp3"],
      updatedAlbums: [
        {
          relPath: "A/Al",
          name: "Al",
          artist: "A",
          tracks: ["a/new.mp3"],
        },
      ],
      updatedTracks: [
        {
          relPath: "a/new.mp3",
          title: "New",
          artist: "A",
          album: "Al",
        },
      ],
    });
    const delta = buildLibraryDelta(root, 3);
    expect(delta.changed).toBe(true);
    expect(delta.removedTrackPaths).toEqual(["a/old.mp3"]);
    expect(delta.addedTrackPaths).toEqual(["a/new.mp3"]);
    expect(delta.updatedAlbums).toHaveLength(1);
    expect(delta.updatedTracks).toHaveLength(1);
  });
});
