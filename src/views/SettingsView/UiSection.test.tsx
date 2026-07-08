import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import UiSection from "./UiSection";
import { defaultUserSettings, mockT, noop } from "./sectionTestUtils";

vi.mock("../../components/ThemePicker", () => ({
  ThemePicker: () => <div data-testid="theme-picker-mock" />,
}));

describe("UiSection", () => {
  it("renders the UI section heading", () => {
    render(
      <UiSection
        t={mockT}
        locale="en"
        setLocale={noop}
        settings={defaultUserSettings}
        updateSettings={noop}
        glassOpacityDraft={62}
        onGlassOpacityChange={noop}
        customThemeDialogOpen={false}
        setCustomThemeDialogOpen={noop}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Theme and visualizer" }),
    ).toBeInTheDocument();
  });
});
