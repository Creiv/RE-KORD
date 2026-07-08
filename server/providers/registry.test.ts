// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ProviderError, searchWithFallback, listProviders } from "../providers/registry.mjs";
import { itunesProvider } from "../providers/itunes.mjs";
import { registerProvider } from "../providers/registry.mjs";

describe("metadata providers", () => {
  it("ProviderError carries code and provider id", () => {
    const err = new ProviderError("rate_limited", "slow down", { provider: "itunes" });
    expect(err.code).toBe("rate_limited");
    expect(err.provider).toBe("itunes");
  });

  it("searchWithFallback returns first provider results", async () => {
    registerProvider({
      ...itunesProvider,
      id: "mock-empty",
      search: async () => [],
    });
    registerProvider({
      id: "mock-hit",
      name: "Mock",
      search: async () => [{ id: "1", title: "Album" }],
      lookup: async () => null,
    });
    const out = await searchWithFallback("test album", { timeoutMs: 2000 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(listProviders().length).toBeGreaterThan(0);
  });
});
