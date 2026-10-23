/**
 * Hub access key (`REKORD_ACCESS_KEY`) for the panel. The panel is served by
 * the hub, so the key belongs to the page's own origin; the storage key is
 * the client's (`apps/client-ui/src/lib/accessKey.ts`), so both UIs on one hub
 * share it. Sent only to same-origin paths, never logged. No Svelte / DOM
 * beyond storage and fetch: the node tests import this file directly.
 */

export const ACCESS_KEY_HEADER = "X-Rekord-Access-Key";
export const ACCESS_KEY_QUERY = "accessKey";
const STORAGE_PREFIX = "rekord.accessKey:";

/** Same rule as the hub (`crates/core/src/access_key.rs`). */
export const MIN_ACCESS_KEY_LEN = 32;
export const MAX_ACCESS_KEY_LEN = 256;
const KEY_CHARS = /^[A-Za-z0-9._~-]+$/;

export type AccessKeyReason = "required" | "invalid" | "locked";

export function isWellFormedAccessKey(raw: string): boolean {
  return (
    raw.length >= MIN_ACCESS_KEY_LEN && raw.length <= MAX_ACCESS_KEY_LEN && KEY_CHARS.test(raw)
  );
}

function pageOrigin(): string | null {
  if (typeof location === "undefined") return null;
  try {
    return new URL(location.origin).origin.toLowerCase();
  } catch {
    return null;
  }
}

function storageKey(): string | null {
  const origin = pageOrigin();
  return origin ? `${STORAGE_PREFIX}${origin}` : null;
}

export function getAccessKey(): string | null {
  const k = storageKey();
  if (!k) return null;
  try {
    return localStorage.getItem(k) || null;
  } catch {
    return null;
  }
}

export function setAccessKey(key: string) {
  const k = storageKey();
  if (!k) return;
  try {
    localStorage.setItem(k, key);
  } catch {
    /* private mode: the prompt comes back on reload */
  }
}

export function clearAccessKey() {
  const k = storageKey();
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch {
    /* nothing stored */
  }
}

/** Same-origin path (`/api/…`), not `//host` nor `/\host` (another origin). */
export function isSameOriginPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

/** Header for a hub call; empty for anything that is not a same-origin path. */
export function accessKeyHeaders(path: string, key = getAccessKey()): Record<string, string> {
  return key && isSameOriginPath(path) ? { [ACCESS_KEY_HEADER]: key } : {};
}

/** `path` with `accessKey=` for `<a href>` / `<img>` (same-origin paths only). */
export function withAccessKeyQuery(path: string, key = getAccessKey()): string {
  if (!key || !isSameOriginPath(path)) return path;
  const hash = path.indexOf("#");
  const head = hash < 0 ? path : path.slice(0, hash);
  const tail = hash < 0 ? "" : path.slice(hash);
  const sep = head.includes("?") ? "&" : "?";
  return `${head}${sep}${ACCESS_KEY_QUERY}=${encodeURIComponent(key)}${tail}`;
}

/**
 * QR content: the address with the key in the fragment, which browsers never
 * send to the server (no proxy logs, no Referer). The RE-KORD apps read it.
 */
export function qrValueWithKey(url: string, key: string): string {
  return `${url.replace(/\/+$/, "")}/#rekordKey=${encodeURIComponent(key)}`;
}

export function accessKeyReason(code: string | null | undefined): AccessKeyReason | null {
  if (code === "access_key_required") return "required";
  if (code === "access_key_invalid") return "invalid";
  if (code === "access_key_rate_limited") return "locked";
  return null;
}

type NeededHandler = (reason: AccessKeyReason, retryAfter: number | null) => void;
let neededHandler: NeededHandler | null = null;

/** The panel session registers here to show the key prompt. */
export function onAccessKeyNeeded(fn: NeededHandler | null) {
  neededHandler = fn;
}

export function reportAccessKeyNeeded(reason: AccessKeyReason, retryAfter: number | null) {
  try {
    neededHandler?.(reason, retryAfter);
  } catch {
    /* a listener must never break a request */
  }
}

export function retryAfterSeconds(res: Response): number | null {
  const n = Number(res.headers.get("Retry-After"));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

export type AccessKeyCheck =
  | { ok: true; required: boolean }
  | { ok: false; reason: "invalid" | "locked" | "unreachable" | "not-hub"; retryAfter?: number | null };

/** Validate `key` against the hub's health endpoint. */
export async function checkAccessKey(key: string, timeoutMs = 10_000): Promise<AccessKeyCheck> {
  let res: Response;
  try {
    res = await fetch("/api/v1/health", {
      cache: "no-store",
      headers: { [ACCESS_KEY_HEADER]: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 429) return { ok: false, reason: "locked", retryAfter: retryAfterSeconds(res) };
  if (res.status === 401) return { ok: false, reason: "invalid" };
  let body: { service?: unknown; accessKey?: unknown } | null = null;
  try {
    body = (await res.json()) as { service?: unknown; accessKey?: unknown };
  } catch {
    body = null;
  }
  if (!res.ok || body?.service !== "RE-KORD") return { ok: false, reason: "not-hub" };
  if (body.accessKey === "required") return { ok: false, reason: "invalid" };
  return { ok: true, required: body.accessKey === "ok" };
}
