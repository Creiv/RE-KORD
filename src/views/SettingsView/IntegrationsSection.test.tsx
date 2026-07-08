import { render, screen } from "@testing-library/react";
import IntegrationsSection from "./IntegrationsSection";
import { createFileInputRef, mockT, noop } from "./sectionTestUtils";

describe("IntegrationsSection", () => {
  it("renders the integrations section heading", () => {
    render(
      <IntegrationsSection
        t={mockT}
        youtubeCookiesConfigured={false}
        youtubeCookiesLockedByEnv={false}
        youtubeCookiesLabel={null}
        youtubeCookiesBusy={false}
        youtubeCookiesErr={null}
        youtubeCookiesOk={null}
        youtubeCookiesInputRef={createFileInputRef()}
        onYoutubeCookiesFileChange={noop}
        removeYoutubeCookies={noop}
        canManageYoutubeCookies={false}
        discogsTokenConfigured={false}
        discogsLockedByEnv={false}
        discogsTokenDraft=""
        setDiscogsTokenDraft={noop}
        discogsBusy={false}
        discogsErr={null}
        discogsOk={null}
        saveDiscogsTokenHandler={noop}
        removeDiscogsToken={noop}
        canManageDiscogs={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Integrations" }),
    ).toBeInTheDocument();
  });
});
