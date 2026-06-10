import { describe, expect, it } from "vitest";
import {
  isDockerGatewayAddress,
  isLoopbackAddress,
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

  it("isDockerGatewayAddress matches only the docker gateway, not LAN clients", () => {
    expect(isDockerGatewayAddress("172.17.0.1")).toBe(true);
    expect(isDockerGatewayAddress("172.18.0.1")).toBe(true);
    expect(isDockerGatewayAddress("192.168.65.2")).toBe(true);
    expect(isDockerGatewayAddress("172.17.0.5")).toBe(false);
    expect(isDockerGatewayAddress("192.168.1.50")).toBe(false);
    expect(isDockerGatewayAddress("10.0.0.5")).toBe(false);
    expect(isDockerGatewayAddress("8.8.8.8")).toBe(false);
  });

  it("isServerAdminRequest allows docker gateway when REKORD_DOCKER=1", () => {
    const prev = process.env.REKORD_DOCKER;
    process.env.REKORD_DOCKER = "1";
    try {
      expect(isServerAdminRequest(fakeReq("172.17.0.1"))).toBe(true);
      expect(isServerAdminRequest(fakeReq("192.168.1.50"))).toBe(false);
      expect(isServerAdminRequest(fakeReq("8.8.8.8"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.REKORD_DOCKER;
      else process.env.REKORD_DOCKER = prev;
    }
  });

  it("isServerAdminRequest denies LAN clients outside docker", () => {
    const prev = process.env.REKORD_DOCKER;
    delete process.env.REKORD_DOCKER;
    try {
      expect(isServerAdminRequest(fakeReq("127.0.0.1"))).toBe(true);
      expect(isServerAdminRequest(fakeReq("192.168.1.50"))).toBe(false);
      expect(isServerAdminRequest(fakeReq("172.17.0.1"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env.REKORD_DOCKER = prev;
    }
  });
});
