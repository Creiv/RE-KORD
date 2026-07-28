export type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = (await res.json()) as Envelope<T> & Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText);
  }
  if ("data" in body && body.data !== undefined) return body.data as T;
  return body as unknown as T;
}

export type LibraryStats = {
  track_count: number;
  album_count: number;
  artist_count: number;
  music_root: string | null;
  last_scan_at: string | null;
  scanning?: boolean;
};

export const api = {
  health: () => fetch("/api/v1/health").then((r) => r.json()),
  stats: () => request<LibraryStats>("/api/v1/library/stats"),
  getPath: () => request<{ music_root: string | null }>("/api/v1/library/path"),
  setPath: (music_root: string) =>
    request<{ music_root: string }>("/api/v1/library/path", {
      method: "PUT",
      body: JSON.stringify({ music_root }),
    }),
  scan: () =>
    request<{
      scanned_files: number;
      indexed_tracks: number;
      skipped: number;
      errors: number;
      music_root: string;
    }>("/api/v1/library/scan", { method: "POST" }),
};
