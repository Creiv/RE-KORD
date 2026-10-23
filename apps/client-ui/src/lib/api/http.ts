/**
 * Transport layer shared by every hub call.
 *
 * One place decides how long a request may hang, which account it speaks for
 * and how a failure is described: network trouble (the hub is gone, the phone
 * lost Wi-Fi) is a different thing from the hub answering "no", and the session
 * only flips to "offline" for the former.
 */
import {
  accessKeyHeaders,
  accessKeyReason,
  isAccessKeyRefused,
  reportAccessKeyNeeded,
} from "../accessKey";
import { accountHeaders, getSelectedAccountId, withAccountQuery } from "../account";
import { getServerBaseUrl, hubUrl } from "../config";
import { i18n, t } from "../i18n.svelte";

/** Default ceiling for a JSON call; long jobs pass their own `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Scans, probes, metadata lookups that shell out to yt-dlp / Discogs. */
export const LONG_TIMEOUT_MS = 120_000;
/** Uploads and full scans: generous, but a dead socket still ends eventually. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type Envelope<T> = { ok: boolean; data?: T; error?: string };

export type ApiErrorKind =
  /** fetch() rejected: DNS, refused, no route, CORS, dropped connection. */
  | "network"
  /** Our own timer gave up. */
  | "timeout"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** The hub answered with a non-2xx status or `ok: false`. */
  | "http"
  /** 2xx with a body we could not read. */
  | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when no response arrived. */
  readonly status: number;
  /** `error` field of the hub envelope, when there was one. */
  readonly code: string | null;
  /** Parsed body for HTTP errors (e.g. the 409 user-state conflict). */
  readonly body: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number; code?: string | null; body?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.code = opts.code ?? null;
    this.body = opts.body;
  }

  /** The hub could not be reached at all (vs. it answered with an error). */
  get offline(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    // Reverse proxies (Vite dev, Cloudflare) answer for a hub that is down.
    return this.kind === "http" && this.body == null && isGatewayStatus(this.status);
  }
}

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 500;
}

/** Network-level failure (offline / unreachable), never a hub-side "no". */
export function isOfflineError(e: unknown): boolean {
  return e instanceof ApiError && e.offline;
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof ApiError && e.kind === "aborted") ||
    (e instanceof DOMException && e.name === "AbortError")
  );
}

type ReachabilityHandler = (reachable: boolean, error?: ApiError) => void;
let reachabilityHandler: ReachabilityHandler | null = null;

/**
 * The session listens here to learn about the hub's reachability from every
 * call, not only from its own refreshes: a request that cannot reach the hub
 * (network error, timeout, gateway 502/503/504) reports `false`, any answer
 * from the hub reports `true`. Aborted calls report nothing.
 */
export function onHubReachability(fn: ReachabilityHandler | null) {
  reachabilityHandler = fn;
}

function reportReachability(reachable: boolean, error?: ApiError) {
  try {
    reachabilityHandler?.(reachable, error);
  } catch {
    /* a listener must never break a request */
  }
}

export type RequestOptions = Omit<RequestInit, "signal"> & {
  /** Milliseconds before giving up; `null` disables the timer (streams). */
  timeoutMs?: number | null;
  signal?: AbortSignal | null;
  /**
   * Speak for this account instead of the session one. Empty string sends no
   * account at all (hub default).
   */
  accountId?: string;
  /** JSON content type header; off for FormData bodies. */
  json?: boolean;
};

function accountQuery(path: string, accountId: string): string {
  const id = accountId.trim();
  if (!id) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}accountId=${encodeURIComponent(id)}`;
}

function buildHeaders(opts: RequestOptions, toHub: boolean): HeadersInit {
  // The key goes only to the hub it was typed for, never to absolute URLs.
  const base: Record<string, string> = toHub ? accessKeyHeaders(getServerBaseUrl()) : {};
  // Only bodies we serialise ourselves are JSON; FormData sets its own boundary.
  const json = opts.json ?? typeof opts.body === "string";
  if (json) base["Content-Type"] = "application/json";
  const extra = (opts.headers ?? {}) as Record<string, string>;
  if (opts.accountId !== undefined) {
    const id = opts.accountId.trim();
    return {
      ...base,
      ...(id ? { "X-Rekord-Account-Id": id, "X-KORD-Account-Id": id } : {}),
      ...extra,
    };
  }
  return accountHeaders({ ...base, ...extra });
}

function resolveUrl(path: string, opts: RequestOptions): string {
  if (/^https?:\/\//i.test(path)) return path;
  const scoped =
    opts.accountId !== undefined
      ? accountQuery(path, opts.accountId)
      : withAccountQuery(path);
  return hubUrl(scoped);
}

/**
 * `fetch` with a timer and the caller's signal folded into one controller.
 * Body reading happens inside `read`, so the timer also covers a hub that
 * sends headers and then stalls.
 */
export async function fetchHub<R>(
  path: string,
  opts: RequestOptions,
  read: (res: Response) => Promise<R>,
): Promise<R> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = opts;
  const init: RequestInit = { ...rest };
  delete (init as RequestOptions).accountId;
  delete (init as RequestOptions).json;
  if (signal?.aborted) {
    throw new ApiError("aborted", t("core.api.aborted"));
  }
  // The hub refused our key and the key screen is up: do not repeat the
  // refusal over the network (polls, sync, the player's probes) until a new
  // key is accepted.
  if (!/^https?:\/\//i.test(path) && isAccessKeyRefused(getServerBaseUrl())) {
    throw new ApiError("http", translateHubError("access_key_invalid", null), {
      status: 401,
      code: "access_key_invalid",
    });
  }
  const timed = timeoutMs != null && timeoutMs > 0;
  // Without a timer the caller's signal goes straight to fetch, so it keeps
  // governing a streamed body after this function has returned the Response.
  const controller = timed ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onCallerAbort = () => controller?.abort(signal?.reason);
  if (controller) {
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs!);
  }
  // Only calls to the hub say something about the hub.
  const toHub = !/^https?:\/\//i.test(path);
  const fail = (e: unknown): never => {
    if (e instanceof ApiError) throw e;
    if (timedOut) {
      const err = new ApiError("timeout", t("core.api.timeout"));
      if (toHub) reportReachability(false, err);
      throw err;
    }
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      throw new ApiError("aborted", t("core.api.aborted"));
    }
    const err = new ApiError("network", t("core.api.network"));
    if (toHub) reportReachability(false, err);
    throw err;
  };
  try {
    let res: Response;
    try {
      res = await fetch(resolveUrl(path, opts), {
        ...init,
        headers: buildHeaders(opts, toHub),
        signal: controller ? controller.signal : (signal ?? undefined),
      });
    } catch (e) {
      return fail(e);
    }
    if (toHub) {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        reportReachability(false, new ApiError("http", res.statusText || `HTTP ${res.status}`, { status: res.status }));
      } else {
        reportReachability(true);
      }
    }
    try {
      return await read(res);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fail(e);
    }
  } finally {
    if (timer != null) clearTimeout(timer);
    if (controller) signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Parse a JSON body; empty / HTML bodies (proxy errors) become an ApiError. */
export async function parseJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    const offline = res.status === 0 || isGatewayStatus(res.status);
    throw new ApiError(
      res.ok ? "parse" : "http",
      offline
        ? t("core.api.unreachableStatus", { status: res.status || "—" })
        : t("core.api.emptyBody", { status: res.status }),
      { status: res.status },
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A gateway's HTML error page while the hub is down still means "offline".
    throw new ApiError(
      res.ok ? "parse" : "http",
      t("core.api.notJson", { status: res.status, body: text.slice(0, 120) }),
      { status: res.status },
    );
  }
}

/** Hub error codes meaning "the account this client is bound to is gone". */
export const ACCOUNT_REJECTED_CODES = new Set(["account_not_found", "invalid_account_id"]);

type AccountRejectedHandler = (accountId: string, code: string) => void;
let accountRejectedHandler: AccountRejectedHandler | null = null;

/**
 * The session registers here to rebind when the hub rejects the stored
 * account (deleted elsewhere, corrupted id). Only requests made for the
 * session account trigger it; explicit `accountId` calls report normally.
 */
export function onAccountRejected(fn: AccountRejectedHandler | null) {
  accountRejectedHandler = fn;
}

/**
 * User text for a hub error: `core.api.errorCode.<code>` when a table has it
 * (codes listed in `docs/API.md` → "Error codes"; feature areas add their own
 * keys under the same prefix in their fragment), else the hub's `message`
 * detail, else the bare code. `fallback` is used when there is nothing at all.
 */
export function translateHubError(
  code: string | null | undefined,
  message?: string | null,
  fallback?: string,
): string {
  const c = (code ?? "").trim();
  if (c && /^[a-z0-9_]+$/.test(c)) {
    const key = `core.api.errorCode.${c}`;
    if (i18n.has(key)) return t(key);
  }
  const detail = (message ?? "").trim();
  if (detail) return detail;
  if (c) return c;
  return fallback ?? t("core.error.unexpected");
}

/** Text for any caught value; hub errors through their code. */
export function describeHubError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message || t("core.error.unexpected");
  return String(e);
}

/** Localised text for a 403 (`forbidden_remote` / `forbidden_default_account` / older free text). */
export function forbiddenMessage(code: string | null): string {
  if (code === "forbidden_remote") return t("core.api.forbiddenRemote");
  if (code === "forbidden_default_account") return t("core.api.forbiddenDefaultAccount");
  if (code && /^[a-z0-9_]+$/.test(code) && i18n.has(`core.api.errorCode.${code}`)) {
    return t(`core.api.errorCode.${code}`);
  }
  const text = (code ?? "").toLowerCase();
  if (text.includes("default") || text === "default_account_required") {
    return t("core.api.forbiddenDefaultAccount");
  }
  if (
    text.includes("computer dell'hub") ||
    text.includes("remote") ||
    text.includes("machine") ||
    text.includes("macchina")
  ) {
    return t("core.api.forbiddenRemote");
  }
  if (code && !/^[a-z0-9_]+$/.test(code)) return t("core.api.forbiddenDetail", { detail: code });
  return t("core.api.forbidden");
}

function httpError(
  res: Response,
  body: unknown,
  fallback?: string,
  opts?: RequestOptions,
): ApiError {
  const env = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    message?: unknown;
  };
  const code = typeof env.error === "string" && env.error ? env.error : null;
  const detail = typeof env.message === "string" ? env.message : null;
  const keyReason = accessKeyReason(code);
  if (keyReason && (res.status === 401 || res.status === 429)) {
    // The hub in use wants a (different) key: the connection gate asks for it.
    reportAccessKeyNeeded(getServerBaseUrl(), keyReason);
    return new ApiError("http", translateHubError(code, null), { status: res.status, code, body });
  }
  if (
    code &&
    ACCOUNT_REJECTED_CODES.has(code) &&
    (res.status === 404 || res.status === 400) &&
    opts?.accountId === undefined
  ) {
    const id = getSelectedAccountId();
    if (id) accountRejectedHandler?.(id, code);
    return new ApiError("http", t("core.api.accountRejected"), {
      status: res.status,
      code,
      body,
    });
  }
  // Host-level operation from a client that may not run it: say so plainly
  // (the hub's own text is often Italian-only or a bare code).
  if (res.status === 403) {
    return new ApiError("http", forbiddenMessage(code), { status: res.status, code, body });
  }
  return new ApiError(
    "http",
    code || detail
      ? translateHubError(code, detail)
      : fallback || res.statusText || `HTTP ${res.status}`,
    { status: res.status, code, body },
  );
}

/** Envelope call (`{ ok, data, error }`): resolves with `data`. */
export function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return fetchHub(path, opts, async (res) => {
    const body = await parseJsonBody<Envelope<T>>(res);
    if (!res.ok || !body.ok) throw httpError(res, body, undefined, opts);
    return body.data as T;
  });
}

/**
 * Bare JSON call (no envelope, `ok: false` optional): resolves with the body.
 * Used by the few endpoints that answer with a flat object.
 */
export function requestJson<T extends { ok?: boolean; error?: string }>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  return fetchHub(path, opts, async (res) => {
    const body = await parseJsonBody<T>(res);
    if (!res.ok || body.ok === false) throw httpError(res, body, undefined, opts);
    return body;
  });
}

/**
 * Binary download (backups, exports): resolves with the blob and the name the
 * hub suggested. HTTP errors still read the JSON envelope for a message.
 */
export function requestBlob(
  path: string,
  opts: RequestOptions & { fallbackError: string; fallbackName: string },
): Promise<{ blob: Blob; name: string }> {
  const { fallbackError, fallbackName, ...rest } = opts;
  return fetchHub(path, { cache: "no-store", json: false, ...rest }, async (res) => {
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* not JSON: keep the fallback message */
      }
      throw httpError(res, body, fallbackError, rest);
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8''|"?)([^";\n]+)/i.exec(cd);
    const raw = (m?.[1] || "").replace(/^["']|["']$/g, "").trim() || fallbackName;
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* already plain */
    }
    return { blob: await res.blob(), name };
  });
}

/** Hand a blob to the browser as a file download. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.click();
  // Some WebViews read the object URL after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
