import { render, screen } from "@testing-library/react";
import ShortcutsSection from "./ShortcutsSection";
import { mockT } from "./sectionTestUtils";

describe("ShortcutsSection", () => {
  it("renders the shortcuts section heading", () => {
    render(<ShortcutsSection t={mockT} />);

    expect(
      screen.getByRole("heading", { name: "Quick use" }),
    ).toBeInTheDocument();
  });
});
