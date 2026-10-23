/**
 * Hub access key (`REKORD_ACCESS_KEY` on the hub), stored on this device.
 *
 * One key per hub origin: a key typed for one hub is never sent to another,
 * because every lookup goes through the origin of the URL being built. API
 * calls carry it in the `X-Rekord-Access-Key` header; `<audio>`, `<img>`,
 * downloads and Cast cannot send headers, so their URLs carry `accessKey=`
 * (see `config.ts`). Never logged.
 */

export const ACCESS_KEY_HEADER = "X-Rekord-Access-Key";
export const ACCESS_KEY_QUERY = "accessKey";

export const ACCESS_KEY_RATE_LIMITED = "access_key_rate_limited";

const STORAGE_PREFIX = "rekord.accessKey:";
/** "The key goes to the Cast device" was acknowledged for this hub's current key. */
const CAST_ACK_PREFIX = "rekord.accessKeyCastAck:";
/** QR / link fragment carrying the key: `#rekordKey=…` (never sent to servers). */
export const ACCESS_KEY_FRAGMENT = "rekordKey";

/** Same rule as the hub (`crates/core/src/access_key.rs`). */
export const MIN_ACCESS_KEY_LEN = 32;
export const MAX_ACCESS_KEY_LEN = 256;
const KEY_CHARS = /^[A-Za-z0-9._~-]+$/;

export function isWellFormedAccessKey(raw: string): boolean {
  return (
    raw.length >= MIN_ACCESS_KEY_LEN && raw.length <= MAX_ACCESS_KEY_LEN && KEY_CHARS.test(raw)
  );
}

/**
 * Lower-case origin of a hub base. Empty base = the page's own origin (the
 * client served by the hub). `null` when it cannot be told.
 */
export function hubOrigin(base: string): string | null {
  const raw = base.trim() || (typeof location === "undefined" ? "" : location.origin);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** In-memory copy, so the many media URLs of a page do not hit storage. */
const cache = new Map<string, string | null>();

/**
 * Hubs that refused this device's key (origin set). While refused, hub calls
 * fail at once without reaching the network (see `api/http.ts`): the key
 * screen is up and every call would only repeat the same refusal. Cleared by
 * a new key, or when the hub no longer asks for one.
 */
const refused = new Set<string>();

export function isAccessKeyRefused(base: string): boolean {
  const origin = hubOrigin(base);
  return origin != null && refused.has(origin);
}

export function clearAccessKeyRefusal(base: string) {
  const origin = hubOrigin(base);
  if (origin) refused.delete(origin);
}

function storageKey(origin: string): string {
  return `${STORAGE_PREFIX}${origin}`;
}

export function getAccessKey(base: string): string | null {
  const origin = hubOrigin(base);
  if (!origin) return null;
  if (cache.has(origin)) return cache.get(origin) ?? null;
  let value: string | null = null;
  try {
    value = localStorage.getItem(storageKey(origin)) || null;
  } catch {
    value = null;
  }
  cache.set(origin, value);
  return value;
}

export function setAccessKey(base: string, key: string) {
  const origin = hubOrigin(base);
  if (!origin) return;
  cache.set(origin, key);
  refused.delete(origin);
  try {
    localStorage.setItem(storageKey(origin), key);
    // A new key is a new thing to warn about before casting.
    localStorage.removeItem(`${CAST_ACK_PREFIX}${origin}`);
  } catch {
    /* private mode: kept for this page */
  }
}

export function clearAccessKey(base: string) {
  const origin = hubOrigin(base);
  if (!origin) return;
  cache.set(origin, null);
  try {
    localStorage.removeItem(storageKey(origin));
    localStorage.removeItem(`${CAST_ACK_PREFIX}${origin}`);
  } catch {
    /* nothing stored */
  }
}

/** True once the person accepted that casting hands this hub's key to the device. */
export function castWarningAcknowledged(base: string): boolean {
  const origin = hubOrigin(base);
  if (!origin) return false;
  try {
    return localStorage.getItem(`${CAST_ACK_PREFIX}${origin}`) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeCastWarning(base: string) {
  const origin = hubOrigin(base);
  if (!origin) return;
  try {
    localStorage.setItem(`${CAST_ACK_PREFIX}${origin}`, "1");
  } catch {
    /* asked again next time */
  }
}

/**
 * The key carried by a `#rekordKey=…` fragment (QR from the hub panel), if
 * well formed. Other fragment parameters are ignored.
 */
export function accessKeyFromFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const key = new URLSearchParams(raw).get(ACCESS_KEY_FRAGMENT)?.trim() ?? "";
  return isWellFormedAccessKey(key) ? key : null;
}

/** `hash` without the key parameter (`""` when nothing else is left). */
export function stripAccessKeyFragment(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  if (!params.has(ACCESS_KEY_FRAGMENT)) return hash;
  params.delete(ACCESS_KEY_FRAGMENT);
  const rest = params.toString();
  return rest ? `#${rest}` : "";
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key == null || event.key.startsWith(STORAGE_PREFIX)) cache.clear();
  });
}

/** Headers for a call to the hub at `base` (empty when it has no key here). */
export function accessKeyHeaders(base: string): Record<string, string> {
  const key = getAccessKey(base);
  return key ? { [ACCESS_KEY_HEADER]: key } : {};
}

/**
 * `url` with `accessKey=` when it points at the hub `base` and a key is
 * stored for it. URLs of any other origin are returned untouched.
 */
export function withAccessKeyQuery(url: string, base: string): string {
  const key = getAccessKey(base);
  if (!key || !url) return url;
  const origin = hubOrigin(base);
  if (/^https?:\/\//i.test(url)) {
    try {
      if (new URL(url).origin.toLowerCase() !== origin) return url;
    } catch {
      return url;
    }
  } else if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) {
    // Only same-origin paths; `//host/…` (and `/\host`, which browsers read
    // the same way) point at another origin.
    return url;
  }
  const hash = url.indexOf("#");
  const head = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  const sep = head.includes("?") ? "&" : "?";
  return `${head}${sep}${ACCESS_KEY_QUERY}=${encodeURIComponent(key)}${tail}`;
}

export type AccessKeyReason = "required" | "invalid" | "locked";

/**
 * A message of the key screen, kept as a table key and translated where it is
 * shown, so it follows a language switch made while it is on screen.
 */
export type AccessKeyMessage = { key: string; vars?: Record<string, string | number> };

/** What the key screen says on arrival: an explicit notice, else what `reason` implies. */
export function initialAccessKeyMessage(
  reason: AccessKeyReason,
  noticeKey?: string,
): AccessKeyMessage | null {
  if (noticeKey) return { key: noticeKey };
  if (reason === "invalid") return { key: "accessKey.errStoredInvalid" };
  return null;
}

type NeededHandler = (base: string, reason: AccessKeyReason) => void;
let neededHandler: NeededHandler | null = null;

/** The connection gate registers here to show the access-key screen. */
export function onAccessKeyNeeded(fn: NeededHandler | null) {
  neededHandler = fn;
}

export function reportAccessKeyNeeded(base: string, reason: AccessKeyReason) {
  const origin = hubOrigin(base);
  if (origin) refused.add(origin);
  try {
    neededHandler?.(base, reason);
  } catch {
    /* a listener must never break a request */
  }
}

/** Reason for a hub error code, or null when it is not about the key. */
export function accessKeyReason(code: string | null | undefined): AccessKeyReason | null {
  if (code === "access_key_required") return "required";
  if (code === "access_key_invalid") return "invalid";
  if (code === ACCESS_KEY_RATE_LIMITED) return "locked";
  return null;
}

export type AccessKeyCheck =
  /** Accepted; `health` is the full body (version, modules…). */
  | { ok: true; health: Record<string, unknown>; required: boolean }
  | { ok: false; reason: "invalid" | "locked" | "unreachable" | "not-hub"; retryAfter?: number };

/**
 * Validate `key` against the hub's health endpoint. An empty key asks the hub
 * whether it needs one at all.
 */
export async function checkAccessKey(
  base: string,
  key: string,
  timeoutMs = 6_000,
): Promise<AccessKeyCheck> {
  const root = (base.trim() || (typeof location === "undefined" ? "" : location.origin)).replace(
    /\/+$/,
    "",
  );
  let res: Response;
  try {
    res = await fetch(`${root}/api/v1/health`, {
      cache: "no-store",
      headers: key ? { [ACCESS_KEY_HEADER]: key } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    return { ok: false, reason: "locked", retryAfter: Number.isFinite(retry) ? retry : undefined };
  }
  if (res.status === 401) return { ok: false, reason: "invalid" };
  if (!res.ok || body?.service !== "RE-KORD") return { ok: false, reason: "not-hub" };
  if (body.accessKey === "required") return { ok: false, reason: "invalid" };
  return { ok: true, health: body, required: body.accessKey === "ok" };
}
