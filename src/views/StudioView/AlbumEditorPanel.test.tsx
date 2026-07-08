import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlbumEditorPanel } from "./AlbumEditorPanel";
import { createMockStudioPanelsState } from "./testHelpers";

vi.mock("../../components/StudioCoversPane", () => ({
  StudioCoversPane: () => (
    <div role="region" aria-label="tools.coversTitle">
      covers
    </div>
  ),
}));

describe("AlbumEditorPanel", () => {
  it("renders the album editor covers pane", () => {
    render(<AlbumEditorPanel state={createMockStudioPanelsState()} />);
    expect(screen.getByRole("region")).toHaveAttribute(
      "aria-label",
      "tools.coversTitle",
    );
  });
});
