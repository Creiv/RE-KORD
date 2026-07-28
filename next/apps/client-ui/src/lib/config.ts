const STORAGE_KEY = "rekord.serverBaseUrl";

/** Empty string = same origin / vite proxy. Absolute URL for remote server. */
export function getServerBaseUrl(): string {
  const fromEnv = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    return (localStorage.getItem(STORAGE_KEY) || "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function setServerBaseUrl(url: string) {
  const cleaned = url.trim().replace(/\/$/, "");
  localStorage.setItem(STORAGE_KEY, cleaned);
}

export function apiUrl(path: string): string {
  const base = getServerBaseUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}

export function mediaUrl(relPath: string): string {
  const encoded = relPath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return apiUrl(`/media/${encoded}`);
}
