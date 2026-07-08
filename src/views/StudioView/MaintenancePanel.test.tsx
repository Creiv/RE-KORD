import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MaintenancePanel } from "./MaintenancePanel";
import { createMockStudioPanelsState } from "./testHelpers";

vi.mock("../../components/StudioEntityInfoCard", () => ({
  StudioEntityInfoCard: () => <div data-testid="entity-info-card" />,
}));

describe("MaintenancePanel", () => {
  it("renders optional maintenance toggle", () => {
    render(
      <MaintenancePanel
        state={createMockStudioPanelsState({ metaOptionalOpen: true })}
      />,
    );
    expect(screen.getByText("tools.metaOptional")).toBeInTheDocument();
    expect(screen.getByText("tools.metaOptionalTitles")).toBeInTheDocument();
  });
});
