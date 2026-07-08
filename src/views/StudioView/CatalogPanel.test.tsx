import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CatalogPanel } from "./CatalogPanel";
import { createMockStudioPanelsState } from "./testHelpers";

vi.mock("../../components/StudioCatalogWeb", () => ({
  StudioCatalogWeb: () => <div data-testid="catalog-web">web</div>,
}));

describe("CatalogPanel", () => {
  it("renders the catalog region in local mode", () => {
    render(
      <CatalogPanel
        state={createMockStudioPanelsState({ catalogStudioMode: "local" })}
      />,
    );
    expect(screen.getByRole("region")).toHaveAttribute(
      "aria-label",
      "tools.catalogTitle",
    );
    expect(screen.getByText("tools.catalogDesc")).toBeInTheDocument();
  });
});
