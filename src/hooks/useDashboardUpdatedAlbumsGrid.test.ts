import { describe, expect, it } from "vitest";
import {
  dashboardUpdatedAlbumSlots,
  dashboardUpdatedAlbumsVisibleCount,
} from "./useDashboardUpdatedAlbumsGrid";

describe("dashboardUpdatedAlbumsVisibleCount", () => {
  it("tronca all'ultima riga completa", () => {
    expect(dashboardUpdatedAlbumsVisibleCount(8, 20, 3)).toBe(6);
    expect(dashboardUpdatedAlbumsVisibleCount(9, 20, 3)).toBe(9);
  });

  it("con una colonna mostra tutti gli album disponibili", () => {
    expect(dashboardUpdatedAlbumsVisibleCount(7, 6, 1)).toBe(6);
    expect(dashboardUpdatedAlbumsVisibleCount(4, 6, 1)).toBe(4);
  });

  it("con pochi album mostra quelli disponibili anche se riga incompleta", () => {
    expect(dashboardUpdatedAlbumsVisibleCount(2, 20, 3)).toBe(2);
  });
});

describe("dashboardUpdatedAlbumSlots", () => {
  it("mobile non è più limitato a 5 slot", () => {
    expect(dashboardUpdatedAlbumSlots(2, true)).toBeGreaterThan(5);
  });

  it("restituisce sempre multipli di colonne", () => {
    expect(dashboardUpdatedAlbumSlots(3, true) % 3).toBe(0);
    expect(dashboardUpdatedAlbumSlots(4, false) % 4).toBe(0);
  });
});
