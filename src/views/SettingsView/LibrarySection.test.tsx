import { render, screen } from "@testing-library/react";
import LibrarySection from "./LibrarySection";
import { mockT, noop } from "./sectionTestUtils";

describe("LibrarySection", () => {
  it("renders the library section heading", () => {
    render(
      <LibrarySection
        t={mockT}
        libLocked={false}
        libraryRootWritable
        libraryRootLabel={null}
        libraryPath="/music"
        setLibraryPath={noop}
        libraryBusy={false}
        libraryProbeHint={null}
        libraryErr={null}
        isKordClientEmbed={false}
        onSaveLibraryPath={noop}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Library root folder" }),
    ).toBeInTheDocument();
  });
});
