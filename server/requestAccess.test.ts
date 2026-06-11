import { describe, expect, it } from "vitest";
import {
  isCloudflareTunnelRequest,
  isDockerGatewayAddress,
  isLoopbackAddress,
  isServerAdminRequest,
} from "./requestAccess.mjs";

function fakeReq(addr: string, headers: Record<string, string> = {}) {
  return {
    socket: { remoteAddress: addr },
    connection: { remoteAddress: addr },
    headers,
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

  it("denies admin to requests via Cloudflare tunnel even from loopback", () => {
    const cfHeaders = {
      host: "abc-def.trycloudflare.com",
      "cf-connecting-ip": "203.0.113.7",
      "cf-ray": "8c1a2b3c4d5e6f70-MXP",
    };
    expect(isCloudflareTunnelRequest(fakeReq("127.0.0.1", cfHeaders))).toBe(
      true,
    );
    expect(isServerAdminRequest(fakeReq("127.0.0.1", cfHeaders))).toBe(false);
    // anche con solo l'host del tunnel (header cf-* assenti)
    expect(
      isServerAdminRequest(
        fakeReq("127.0.0.1", { host: "abc-def.trycloudflare.com" }),
      ),
    ).toBe(false);
    // loopback "vero" (senza header tunnel) resta admin
    expect(
      isServerAdminRequest(fakeReq("127.0.0.1", { host: "localhost:3001" })),
    ).toBe(true);
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
