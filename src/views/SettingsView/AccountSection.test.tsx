import { render, screen } from "@testing-library/react";
import AccountSection from "./AccountSection";
import { mockT, noop } from "./sectionTestUtils";

describe("AccountSection", () => {
  it("renders the account section heading", () => {
    render(
      <AccountSection
        t={mockT}
        accountErr={null}
        accounts={null}
        selectedAccount={null}
        accountBusy={false}
        libLocked={false}
        newAccountName=""
        setNewAccountName={noop}
        createNewAccount={noop}
        selectSessionAccount={noop}
        removeAccount={async () => undefined}
        accountLevelFor={() => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Local sessions" }),
    ).toBeInTheDocument();
  });
});
