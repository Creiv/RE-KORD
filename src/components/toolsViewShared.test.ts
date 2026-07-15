import { describe, expect, it } from "vitest";
import { defaultStudioPane, readStoredStudioPane } from "./toolsViewShared";

describe("defaultStudioPane", () => {
  it("returns catalog on mobile client embed when no stored pane", () => {
    document.documentElement.dataset.rekordClient = "1";
    localStorage.removeItem("rekord-studio-pane");
    expect(defaultStudioPane()).toBe("catalog");
    delete document.documentElement.dataset.rekordClient;
  });

  it("returns listen on desktop when no stored pane", () => {
    localStorage.removeItem("rekord-studio-pane");
    delete document.documentElement.dataset.rekordClient;
    expect(defaultStudioPane()).toBe("listen");
  });

  it("prefers stored pane over defaults", () => {
    localStorage.setItem("rekord-studio-pane", "meta");
    expect(defaultStudioPane()).toBe("meta");
    expect(readStoredStudioPane()).toBe("meta");
    localStorage.removeItem("rekord-studio-pane");
  });
});
