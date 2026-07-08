import { render, screen } from "@testing-library/react";
import NetworkSection from "./NetworkSection";
import { mockT, noop } from "./sectionTestUtils";

describe("NetworkSection", () => {
  it("renders the network section heading", () => {
    render(
      <NetworkSection
        t={mockT}
        lanAccessUrl={null}
        publicIp={null}
        publicIpLoading={false}
        remoteAccess={null}
        remoteAccessBusy={false}
        remoteAccessErr={null}
        remoteLoginHover={false}
        setRemoteLoginHover={noop}
        remoteShareHover={false}
        setRemoteShareHover={noop}
        isNetworkControlAllowed={false}
        runRemoteCloudflareLogin={noop}
        logoutRemoteCloudflareLogin={noop}
        toggleRemoteAccess={noop}
        copyRemotePublicUrl={async () => undefined}
        remoteUrlCopyOk={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Ports and LAN" }),
    ).toBeInTheDocument();
  });
});
