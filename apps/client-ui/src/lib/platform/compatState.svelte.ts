/**
 * State of the update banner (`components/UpdateBanner.svelte`).
 *
 * It is fed from two paths: the connection flow's probe
 * (`connect.svelte.ts`, which already has `/api/v1/health` in hand) and a
 * light background check — at startup, on returning to the foreground, every so often —
 * because the hub can be updated while the client is open.
 */

import { accessKeyHeaders, clearAccessKeyRefusal } from "../accessKey";
import { getServerBaseUrl } from "../config";
import { APP_VERSION } from "../version";
import { evaluateCompat, type CompatVerdict, type HealthInfo } from "./compat";
import { isBundledUi, isTauri } from "./env";

const DISMISS_KEY = "rekord.compatDismissed";
const RECHECK_MS = 30 * 60_000;
const MIN_GAP_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) || "";
  } catch {
    return "";
  }
}

function verdictKey(v: CompatVerdict): string {
  return v.kind === "ok" ? "" : `${v.kind}@${v.hubVersion}`;
}

class CompatStore {
  verdict = $state<CompatVerdict>({ kind: "ok" });
  /** Key of the notice closed by hand: the same notice does not come back until the next change. */
  dismissed = $state(readDismissed());

  get visible(): boolean {
    if (this.verdict.kind === "ok") return false;
    // The blocking notice does not close forever: it stays until an update happens.
    if (this.verdict.kind === "client-too-old") return true;
    return verdictKey(this.verdict) !== this.dismissed;
  }

  apply(health: HealthInfo | null | undefined) {
    this.verdict = evaluateCompat({
      clientVersion: APP_VERSION,
      bundled: isBundledUi(),
      health,
    });
  }

  dismiss() {
    this.dismissed = verdictKey(this.verdict);
    try {
      localStorage.setItem(DISMISS_KEY, this.dismissed);
    } catch {
      /* storage full or denied: the notice comes back on the next startup, never mind */
    }
  }
}

export const compat = new CompatStore();

function currentHubBase(): string | null {
  const saved = getServerBaseUrl();
  if (saved) return saved;
  // Without a saved address, in the browser the hub is the page's origin; in the
  // native shell the origin is the app itself and there is nothing to ask.
  if (isTauri() || typeof location === "undefined") return null;
  return location.origin.startsWith("http") ? location.origin : null;
}

let lastCheck = 0;

/** Asks the current hub for `/api/v1/health` and updates the verdict. Never an error. */
export async function checkHubCompat(base: string | null = currentHubBase()): Promise<void> {
  if (!base) return;
  lastCheck = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/v1/health`, {
      cache: "no-store",
      // With the key the hub sends the full health (version included).
      headers: accessKeyHeaders(base),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return;
    const body = (await res.json()) as HealthInfo & { service?: string };
    if (body?.service !== "RE-KORD") return;
    // Full health with our key: a refusal noted earlier no longer holds.
    const accessKey = (body as { accessKey?: unknown }).accessKey;
    if (accessKey === "ok" || accessKey === "off") clearAccessKeyRefusal(base);
    compat.apply(body);
  } catch {
    /* Hub unreachable: the connection indicator handles it, not this banner. */
  }
}

/** Periodic checks; returns the function that stops them. */
export function watchHubCompat(): () => void {
  if (typeof window === "undefined") return () => {};
  const maybe = () => {
    if (Date.now() - lastCheck >= MIN_GAP_MS) void checkHubCompat();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") maybe();
  };
  const timer = window.setInterval(() => void checkHubCompat(), RECHECK_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", maybe);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", maybe);
  };
}
