import { describe, expect, it } from "vitest";
import {
  setVisualSurfaceContext,
  shouldPauseListenStageVisualizers,
  shouldPauseNebulaCanvas,
} from "./useVisualSurfaceActive";

describe("useVisualSurfaceActive", () => {
  it("pausa Nebula dashboard fuori sezione", () => {
    setVisualSurfaceContext({ section: "studio", libBrowse: "artists" });
    expect(shouldPauseNebulaCanvas("dashboard")).toBe(true);
    setVisualSurfaceContext({ section: "dashboard" });
    expect(shouldPauseNebulaCanvas("dashboard")).toBe(false);
  });

  it("pausa Nebula library se tab browse non è nebula", () => {
    setVisualSurfaceContext({ section: "libreria", libBrowse: "artists" });
    expect(shouldPauseNebulaCanvas("library")).toBe(true);
    setVisualSurfaceContext({ libBrowse: "nebula" });
    expect(shouldPauseNebulaCanvas("library")).toBe(false);
  });

  it("pausa visualizer Ascolta fuori pannello listen", () => {
    setVisualSurfaceContext({ section: "studio", studioPane: "catalog" });
    expect(shouldPauseListenStageVisualizers()).toBe(true);
    setVisualSurfaceContext({ studioPane: "listen" });
    expect(shouldPauseListenStageVisualizers()).toBe(false);
    setVisualSurfaceContext({ section: "dashboard" });
    expect(shouldPauseListenStageVisualizers()).toBe(true);
  });
});
