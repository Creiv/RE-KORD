import { describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  isPrivateOrDockerGatewayAddress,
  isServerAdminRequest,
} from "./requestAccess.mjs";

function fakeReq(addr: string) {
  return {
    socket: { remoteAddress: addr },
    connection: { remoteAddress: addr },
  };
}

describe("requestAccess", () => {
  it("isLoopbackAddress matches localhost forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("172.17.0.1")).toBe(false);
  });

  it("isPrivateOrDockerGatewayAddress matches docker bridge", () => {
    expect(isPrivateOrDockerGatewayAddress("172.17.0.1")).toBe(true);
    expect(isPrivateOrDockerGatewayAddress("192.168.65.2")).toBe(true);
    expect(isPrivateOrDockerGatewayAddress("8.8.8.8")).toBe(false);
  });

  it("isServerAdminRequest allows docker gateway when REKORD_DOCKER=1", () => {
    const prev = process.env.REKORD_DOCKER;
    process.env.REKORD_DOCKER = "1";
    try {
      expect(isServerAdminRequest(fakeReq("172.17.0.1"))).toBe(true);
      expect(isServerAdminRequest(fakeReq("8.8.8.8"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.REKORD_DOCKER;
      else process.env.REKORD_DOCKER = prev;
    }
  });
});
