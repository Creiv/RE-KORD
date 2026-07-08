import { ProviderError } from "./registry.mjs";

/**
 * Provider iTunes Search API (no auth).
 * @type {import('./registry.mjs').MetadataProvider}
 */
export const itunesProvider = {
  id: "itunes",
  name: "iTunes",
  async search(query) {
    const q = encodeURIComponent(String(query || "").trim());
    if (!q) return [];
    const url = `https://itunes.apple.com/search?term=${q}&entity=album&limit=8`;
    const res = await fetch(url, {
      headers: { "User-Agent": "RE-KORD/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) throw new ProviderError("rate_limited", "iTunes rate limited", { provider: "itunes" });
    if (!res.ok) throw new ProviderError("unavailable", `iTunes HTTP ${res.status}`, { provider: "itunes" });
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  },
  async lookup(id) {
    const albumId = String(id || "").trim();
    if (!albumId) return null;
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new ProviderError("unavailable", `iTunes lookup HTTP ${res.status}`, { provider: "itunes" });
    const data = await res.json();
    return data?.results?.[0] ?? null;
  },
};
