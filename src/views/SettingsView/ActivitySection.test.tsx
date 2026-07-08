import { render, screen } from "@testing-library/react";
import ActivitySection from "./ActivitySection";
import { mockT, noop } from "./sectionTestUtils";

describe("ActivitySection", () => {
  it("renders the activity log section heading", () => {
    render(
      <ActivitySection
        t={mockT}
        locale="en"
        activityLog={[]}
        activityLogErr={null}
        activityLogBusy={false}
        loadActivityLog={noop}
        accountNameById={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Server activity log" }),
    ).toBeInTheDocument();
  });
});
