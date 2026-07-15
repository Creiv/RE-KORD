import { describe, expect, it, vi } from "vitest";
import {
  extractCloudflareTunnelUrl,
  isTryCloudflareHost,
  normalizeRemoteClientBaseUrl,
  remoteAccessState,
  remoteSnapshot,
  resolveCloudflaredTarget,
  waitForTunnelReachable,
} from "./remoteAccess.mjs";

describe("extractCloudflareTunnelUrl", () => {
  it("estrae l'URL da una riga completa di cloudflared", () => {
    const line =
      "2026-07-10T18:27:35Z INF |  https://lambda-fighting-scene-insulin.trycloudflare.com                                   |";
    expect(extractCloudflareTunnelUrl(line)).toBe(
      "https://lambda-fighting-scene-insulin.trycloudflare.com",
    );
  });

  it("ricostruisce l'URL quando l'output arriva spezzato su più chunk", () => {
    const chunks = [
      "2026-07-10T18:27:35Z INF |  https://lambda-fight",
      "ing-scene-insulin.trycloudflare.com                                   |",
    ];
    let buffer = "";
    let url = null;
    for (const chunk of chunks) {
      buffer += chunk;
      url = extractCloudflareTunnelUrl(buffer) ?? url;
    }
    expect(url).toBe("https://lambda-fighting-scene-insulin.trycloudflare.com");
  });
});

describe("normalizeRemoteClientBaseUrl", () => {
  it("forza https per host trycloudflare", () => {
    expect(
      normalizeRemoteClientBaseUrl("http://abc-def.trycloudflare.com/"),
    ).toBe("https://abc-def.trycloudflare.com");
    expect(normalizeRemoteClientBaseUrl("abc-def.trycloudflare.com")).toBe(
      "https://abc-def.trycloudflare.com",
    );
  });

  it("lascia invariati gli URL LAN", () => {
    expect(normalizeRemoteClientBaseUrl("192.168.1.10:3001")).toBe(
      "http://192.168.1.10:3001",
    );
  });
});

describe("isTryCloudflareHost", () => {
  it("riconosce sottodomini trycloudflare", () => {
    expect(isTryCloudflareHost("abc.trycloudflare.com")).toBe(true);
    expect(isTryCloudflareHost("trycloudflare.com")).toBe(true);
    expect(isTryCloudflareHost("example.com")).toBe(false);
  });
});

describe("remoteSnapshot", () => {
  it("espone publicUrl solo con tunnel running", () => {
    const prevStatus = remoteAccessState.status;
    const prevUrl = remoteAccessState.publicUrl;
    try {
      remoteAccessState.status = "starting";
      remoteAccessState.publicUrl = "https://abc-def.trycloudflare.com";
      expect(remoteSnapshot().publicUrl).toBeNull();
      remoteAccessState.status = "running";
      expect(remoteSnapshot().publicUrl).toBe("https://abc-def.trycloudflare.com");
      remoteAccessState.status = "stopped";
      expect(remoteSnapshot().publicUrl).toBeNull();
    } finally {
      remoteAccessState.status = prevStatus;
      remoteAccessState.publicUrl = prevUrl;
    }
  });
});

describe("resolveCloudflaredTarget", () => {
  it("usa 127.0.0.1 quando il server ascolta su tutte le interfacce", () => {
    expect(resolveCloudflaredTarget()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("waitForTunnelReachable", () => {
  it("ritorna quando /api/health pubblico risponde ok", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("local skip"))
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValueOnce({ ok: true });
    const out = await waitForTunnelReachable(
      "https://abc-def.trycloudflare.com",
      {
        timeoutMs: 5000,
        intervalMs: 1,
        fetchImpl,
        dnsLookupImpl: async () => "1.2.3.4",
        localHealthUrl: "http://127.0.0.1:3001/api/health",
        isAlive: () => true,
      },
    );
    expect(out).toBe("https://abc-def.trycloudflare.com");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("accetta DNS + backend locale quando l'URL pubblico non è verificabile", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("trycloudflare.com")) {
        throw new Error("hairpin blocked");
      }
      return { ok: true };
    });
    const out = await waitForTunnelReachable(
      "https://abc-def.trycloudflare.com",
      {
        timeoutMs: 5000,
        intervalMs: 1,
        fetchImpl,
        dnsLookupImpl: async () => "1.2.3.4",
        localHealthUrl: "http://127.0.0.1:3001/api/health",
        isAlive: () => true,
      },
    );
    expect(out).toBe("https://abc-def.trycloudflare.com");
  });

  it("propaga errore se né pubblico né fallback locale diventano pronti", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      waitForTunnelReachable("https://abc-def.trycloudflare.com", {
        timeoutMs: 5,
        intervalMs: 1,
        fetchImpl,
        dnsLookupImpl: async () => {
          throw new Error("ENOTFOUND");
        },
        localHealthUrl: "http://127.0.0.1:3001/api/health",
        isAlive: () => true,
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
