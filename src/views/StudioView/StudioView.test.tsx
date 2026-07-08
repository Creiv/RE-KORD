import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudioView } from "./StudioView";
import { createMockStudioPanelsState } from "./testHelpers";

vi.mock("./hooks/useStudioNavigation", () => ({
  useStudioNavigation: () => ({
    studioPane: "catalog",
    setStudioPane: vi.fn(),
    studioOverviewIcon: <span data-testid="pane-icon" />,
  }),
}));

vi.mock("./hooks/useStudioLibrarySync", () => ({
  useStudioLibrarySync: vi.fn(),
}));

vi.mock("./hooks/useStudioPanels", () => ({
  useStudioPanels: () => createMockStudioPanelsState({ studioPane: "catalog" }),
}));

vi.mock("./CatalogPanel", () => ({
  CatalogPanel: () => <div data-testid="catalog-panel">catalog</div>,
}));

vi.mock("./DownloadPanel", () => ({
  DownloadPanel: () => <div data-testid="download-panel">download</div>,
}));

vi.mock("./EnrichPanel", () => ({
  EnrichPanel: () => <div data-testid="enrich-panel">enrich</div>,
}));

vi.mock("./MaintenancePanel", () => ({
  MaintenancePanel: () => <div data-testid="maintenance-panel">maint</div>,
}));

vi.mock("./AlbumEditorPanel", () => ({
  AlbumEditorPanel: () => <div data-testid="album-editor-panel">covers</div>,
}));

vi.mock("../../i18n/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key, sortLocale: "en" }),
}));

describe("StudioView", () => {
  it("renders studio tabs and active catalog panel", () => {
    render(
      <StudioView
        library={null}
        libraryIndex={null}
        onReconcileLibrary={vi.fn()}
      />,
    );
    expect(screen.getByText("tools.studioOverviewEyebrow")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "tools.studioTabCatalog" }))
      .toHaveClass("is-on");
  });
});
