import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EnrichPanel } from "./EnrichPanel";
import { createMockStudioPanelsState } from "./testHelpers";

describe("EnrichPanel", () => {
  it("renders metadata enrichment controls", () => {
    render(<EnrichPanel state={createMockStudioPanelsState()} />);
    expect(screen.getByText("tools.metaEssentials")).toBeInTheDocument();
    expect(screen.getByLabelText("tools.pickerArtist")).toBeInTheDocument();
  });
});
