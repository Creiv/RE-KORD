import { describe, expect, it } from "vitest";
import { isPaginatedLibraryEnabled } from "./usePaginatedArtists";

describe("usePaginatedArtists", () => {
  it("isPaginatedLibraryEnabled legge VITE_REKORD_PAGINATED_LIBRARY", () => {
    expect(typeof isPaginatedLibraryEnabled()).toBe("boolean");
  });
});
