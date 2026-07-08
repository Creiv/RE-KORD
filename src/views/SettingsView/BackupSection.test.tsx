import { render, screen } from "@testing-library/react";
import BackupSection from "./BackupSection";
import { createFileInputRef, mockT, noop } from "./sectionTestUtils";

describe("BackupSection", () => {
  it("renders the backup section heading", () => {
    render(
      <BackupSection
        t={mockT}
        backupBusy={false}
        backupOk={null}
        backupErr={null}
        themeExportBusy={false}
        restoreBusy={false}
        restoreOk={null}
        restoreErr={null}
        restoreFileInputRef={createFileInputRef()}
        runKordBackup={noop}
        runThemeExport={noop}
        onRestoreFileChange={noop}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "RE-KORD config, user data, and library metadata (no audio, all users)",
      }),
    ).toBeInTheDocument();
  });
});
