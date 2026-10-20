/**
 * First launch: which hub to connect to and with which account.
 *
 * In the browser served by the hub none of this is visible, because the hub
 * is the page's origin and answers right away. It is needed in the APK and in the
 * desktop client, where the UI is inside the app and the hub is an address only
 * the person installing it knows.
 */

import {
  accessKeyFromFragment,
  accessKeyHeaders,
  checkAccessKey,
  clearAccessKeyRefusal,
  getAccessKey,
  onAccessKeyNeeded,
  setAccessKey,
  stripAccessKeyFragment,
  type AccessKeyReason,
} from "./accessKey";
import { hubModules } from "./hubModules.svelte";
import { getSelectedAccountId, type Account, type AccountsResponse } from "./account";
import { getServerBaseUrl, setServerBaseUrl } from "./config";
import { i18n } from "./i18n.svelte";
import { checkHubCompat, compat } from "./platform/compatState.svelte";
import { isTauri } from "./platform/env";

export type ConnectPhase =
  /** Silent probe at startup: show the logo, not a question yet. */
  | "probing"
  | "connect"
  /** The hub wants an access key this device does not have (or a new one). */
  | "access-key"
  | "app";

export type ProbeFailure =
  | { reason: "unreachable" }
  | { reason: "timeout" }
  | { reason: "http"; status: number }
  | { reason: "not-hub" }
  | { reason: "no-accounts" }
  /** The hub requires an access key: none stored here, or a wrong one. */
  | { reason: "access-key"; detail: AccessKeyReason };

export type HubProbe =
  | {
      ok: true;
      accounts: Account[];
      defaultAccountId: string;
      version: string;
      /** `/api/v1` API version declared by the hub (absent on hubs < 5.1). */
      apiVersion: number | null;
      /** Oldest client the hub accepts (see `platform/compat.ts`). */
      minClientVersion: string;
    }
  | ({ ok: false } & ProbeFailure);

/**
 * Six seconds: a hub on the local network answers in milliseconds, and past this
 * threshold whoever is in front of the screen has already realised the address is wrong.
 */
const PROBE_TIMEOUT_MS = 6_000;

/** Shorter probe at startup: here we only decide whether to show the flow. */
const STARTUP_PROBE_TIMEOUT_MS = 3_500;

/**
 * Desktop client and hub on the same machine: the normal case on a computer, and
 * the only address that can be guessed. On a phone the port is closed and
 * the attempt ends immediately, without making anyone wait.
 */
const LOCAL_HUB = "http://127.0.0.1:7420";
const LOCAL_PROBE_TIMEOUT_MS = 1_500;

async function getJson(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown } | { status: 0; body: null }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Asks the hub «are you there?» and «what accounts do you have?». The two questions go
 * together because the useful answer is a single one: can we get in, and with which profile.
 */
export async function probeHub(
  base: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HubProbe> {
  const root = base.replace(/\/+$/, "");
  // Only the key stored for this very hub.
  const keyHeaders = accessKeyHeaders(root);
  let health: { status: number; body: unknown };
  try {
    health = await getJson(`${root}/api/v1/health`, timeoutMs, keyHeaders);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  const keyError = accessKeyFailure(health.status, health.body);
  if (keyError) return keyError;
  if (health.status !== 200) return { ok: false, reason: "http", status: health.status };
  const info = (health.body ?? {}) as {
    service?: string;
    version?: string;
    apiVersion?: unknown;
    minClientVersion?: unknown;
    accessKey?: unknown;
  };
  // A wifi portal or another server on the same port answers 200 to everything:
  // without this check the flow would close on an address that is not
  // a hub, and the error would show up ten screens later.
  if (info.service !== "RE-KORD") return { ok: false, reason: "not-hub" };
  // The version notice is decided right here: a client that is too old must
  // know before getting in, not ten screens later.
  compat.apply(info);
  // Without a valid key the health is minimal: the rest is read once the key is accepted.
  if (info.accessKey === "required") {
    return { ok: false, reason: "access-key", detail: getAccessKey(root) ? "invalid" : "required" };
  }
  hubModules.apply(info);
  // The hub took our key (or wants none): calls to it may go out again.
  clearAccessKeyRefusal(root);

  let accounts: { status: number; body: unknown };
  try {
    accounts = await getJson(`${root}/api/v1/accounts`, timeoutMs, keyHeaders);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  const accountsKeyError = accessKeyFailure(accounts.status, accounts.body);
  if (accountsKeyError) return accountsKeyError;
  if (accounts.status !== 200) {
    return { ok: false, reason: "http", status: accounts.status };
  }
  const envelope = (accounts.body ?? {}) as {
    data?: { accounts?: Account[]; defaultAccountId?: string };
  };
  const list = envelope.data?.accounts ?? [];
  if (!list.length) return { ok: false, reason: "no-accounts" };
  return {
    ok: true,
    accounts: list,
    defaultAccountId: envelope.data?.defaultAccountId || list[0].id,
    version: info.version || "",
    apiVersion: typeof info.apiVersion === "number" ? info.apiVersion : null,
    minClientVersion: typeof info.minClientVersion === "string" ? info.minClientVersion : "",
  };
}

/** 401 / 429 `access_key_*` from the hub, as a probe failure. */
function accessKeyFailure(status: number, body: unknown): HubProbe | null {
  if (status !== 401 && status !== 429) return null;
  const code = (body as { error?: unknown } | null)?.error;
  if (code === "access_key_rate_limited") return { ok: false, reason: "access-key", detail: "locked" };
  if (code === "access_key_required") return { ok: false, reason: "access-key", detail: "required" };
  if (code === "access_key_invalid") return { ok: false, reason: "access-key", detail: "invalid" };
  return null;
}

/**
 * `#rekordKey=…` from the hub panel's QR opened in a browser: the page is the
 * hub itself, so the key belongs to this origin. Taken out of the address bar
 * (and history) at once. In the native shell the origin is the app: ignored.
 */
function takeAccessKeyFragment() {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return;
  const key = accessKeyFromFragment(location.hash);
  if (location.hash && stripAccessKeyFragment(location.hash) !== location.hash) {
    try {
      const hash = stripAccessKeyFragment(location.hash);
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    } catch {
      /* the key still works; only the address bar keeps it */
    }
  }
  if (key) setAccessKey(location.origin, key);
}

/**
 * The local hub is guessed only from the native shell: from a web page served by
 * another origin the attempt would be a cross-origin request (CORS error in the
 * console) to a port that is almost never the right one.
 */
function mayProbeLocalHub(): boolean {
  if (isTauri()) return true;
  if (typeof location === "undefined") return false;
  return !/^https?:$/.test(location.protocol);
}

class ConnectGate {
  phase = $state<ConnectPhase>("probing");
  /** Address to prefill in the fields: the last saved one, if any. */
  savedBase = $state("");
  /** Account the client is bound to now (the screen marks it in the list). */
  currentAccountId = $state<string | null>(getSelectedAccountId());
  /** Hub asking for an access key, and why (phase `access-key`). */
  keyBase = $state("");
  keyReason = $state<AccessKeyReason>("required");
  /** Opened from settings: the person may go back without a new key. */
  keyCancellable = $state(false);
  /** Phase to go back to once the key is accepted. */
  private afterKey: ConnectPhase = "app";

  constructor() {
    // Any hub call refused for the key (expired, changed on the hub) lands here.
    onAccessKeyNeeded((base, reason) => this.requireKey(base, reason));
  }

  /** Show the access-key screen for `base` (empty = the page's own hub). */
  requireKey(base: string, reason: AccessKeyReason) {
    if (this.phase === "access-key" || this.phase === "connect") return;
    this.keyBase = base;
    this.keyReason = reason;
    this.keyCancellable = false;
    this.afterKey = this.phase === "probing" ? "app" : this.phase;
    this.phase = "access-key";
  }

  /** Settings › Access key › Change: same screen, with a way back. */
  changeKey(base: string) {
    if (this.phase !== "app") return;
    this.keyBase = base;
    this.keyReason = "required";
    this.keyCancellable = true;
    this.afterKey = "app";
    this.phase = "access-key";
  }

  /** Key accepted (already stored): back to where the app was. */
  keyAccepted() {
    this.keyCancellable = false;
    this.phase = this.afterKey;
  }

  /** Back from a change started in settings, keeping the current key. */
  cancelKey() {
    if (!this.keyCancellable) return;
    this.keyCancellable = false;
    this.phase = this.afterKey;
  }

  /** Last successful startup probe: the session reuses it instead of redoing it. */
  private lastProbe: { base: string; at: number; data: AccountsResponse } | null = null;

  private rememberProbe(base: string, probe: HubProbe) {
    if (!probe.ok) return;
    this.lastProbe = {
      base,
      at: Date.now(),
      data: { accounts: probe.accounts, defaultAccountId: probe.defaultAccountId },
    };
  }

  /**
   * «accounts» answer of the startup probe, if it is recent and concerns the hub in
   * use: the session startup does not redo the same two requests. Only once.
   */
  takeRecentProbe(maxAgeMs: number): AccountsResponse | null {
    const p = this.lastProbe;
    this.lastProbe = null;
    if (!p || Date.now() - p.at > maxAgeMs) return null;
    const base = (getServerBaseUrl() || (typeof location === "undefined" ? "" : location.origin))
      .replace(/\/+$/, "");
    if (p.base.replace(/\/+$/, "") !== base) return null;
    return p.data;
  }

  /**
   * At startup: with an address already saved we just go in — if the hub does not
   * answer, the session's reconnect loop takes care of it, with the
   * UI up.
   *
   * Without an address we first try the page's origin, which in the browser is
   * the hub itself, and then the local hub. Only if nobody answers do we ask
   * where it is: the first-launch flow must not appear to someone who opened
   * the UI served by the hub.
   */
  async decideOnStart(): Promise<boolean> {
    // The boot splash has no text: wait there for the user's language, so
    // nothing is ever painted in the fallback language first.
    const ready = await this.decide();
    await i18n.ready;
    // `decide` may have asked for a key already: that screen stays.
    if (this.phase !== "access-key") this.phase = ready ? "app" : "connect";
    return ready;
  }

  private async decide(): Promise<boolean> {
    takeAccessKeyFragment();
    this.savedBase = getServerBaseUrl();
    if (this.savedBase) {
      if (!getAccessKey(this.savedBase)) {
        // No key here: ask the hub first, so a hub that wants one shows the
        // key screen instead of an app full of refusals. Unreachable: go in,
        // the reconnect loop takes over (as without a key).
        const need = await checkAccessKey(this.savedBase, "", STARTUP_PROBE_TIMEOUT_MS);
        if (!need.ok && need.reason !== "unreachable" && need.reason !== "not-hub") {
          this.askKeyAtStart(this.savedBase, need.reason === "locked" ? "locked" : "required");
          return true;
        }
      }
      // Go in right away; compatibility with the hub is checked in the background.
      void checkHubCompat(this.savedBase);
      return true;
    }
    const origin = typeof location === "undefined" ? "" : location.origin;
    if (origin.startsWith("http")) {
      const probe = await probeHub(origin, STARTUP_PROBE_TIMEOUT_MS);
      if (probe.ok) {
        this.rememberProbe(origin, probe);
        return true;
      }
      if (probe.reason === "access-key") {
        // The client served by the hub: same origin, no address to save.
        this.askKeyAtStart("", probe.detail);
        return true;
      }
    }
    if (!mayProbeLocalHub()) return false;
    const local = await probeHub(LOCAL_HUB, LOCAL_PROBE_TIMEOUT_MS);
    if (!local.ok && local.reason === "access-key") {
      setServerBaseUrl(LOCAL_HUB);
      this.savedBase = LOCAL_HUB;
      this.askKeyAtStart(LOCAL_HUB, local.detail);
      return true;
    }
    if (local.ok) {
      this.rememberProbe(LOCAL_HUB, local);
      // It must be saved: in the native shell the origin is the app, and without a base the
      // calls would end up on tauri://localhost.
      setServerBaseUrl(LOCAL_HUB);
      this.savedBase = LOCAL_HUB;
      return true;
    }
    return false;
  }

  private askKeyAtStart(base: string, reason: AccessKeyReason) {
    this.keyBase = base;
    this.keyReason = reason;
    this.keyCancellable = false;
    this.afterKey = "app";
    this.phase = "access-key";
  }

  /** Reopens the flow: from settings, or when the hub has changed address. */
  open() {
    this.savedBase = getServerBaseUrl();
    this.currentAccountId = getSelectedAccountId();
    this.phase = "connect";
  }

  close() {
    this.phase = "app";
  }
}

export const connectGate = new ConnectGate();
