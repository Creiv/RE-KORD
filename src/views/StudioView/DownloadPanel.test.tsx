import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DownloadPanel } from "./DownloadPanel";
import { createMockStudioPanelsState } from "./testHelpers";

vi.mock("../../components/StudioDownloadExplore", () => ({
  StudioDownloadExplore: () => <div data-testid="download-explore">explore</div>,
}));

describe("DownloadPanel", () => {
  it("renders the download region", () => {
    render(<DownloadPanel state={createMockStudioPanelsState()} />);
    expect(screen.getByRole("region")).toHaveAttribute(
      "aria-label",
      "tools.downloadTitle",
    );
    expect(screen.getByText("tools.dlSaveFolder")).toBeInTheDocument();
  });
});
