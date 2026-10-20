/**
 * Parsing of the hub address typed by hand or read from a QR.
 *
 * It lives apart from the connection screen because it is all string logic,
 * the only part of the first launch that is really easy to get wrong: whoever installs the APK types
 * «192.168.1.20:7420» by hand, and whoever scans the tunnel QR gets a URL with
 * a path inside.
 */

import { accessKeyFromFragment, isWellFormedAccessKey } from "./accessKey";

/** Hub port: `--bind 0.0.0.0:7420` is the server's stock value. */
export const DEFAULT_HUB_PORT = "7420";

export type HubAddress = {
  /** Origin to save as the base for API calls: no trailing slash. */
  base: string;
  host: string;
  port: string;
  https: boolean;
};

/**
 * Accepts what a person types: `192.168.1.20`, `192.168.1.20:7420`,
 * `http://…`, `https://nome.trycloudflare.com`, with or without a trailing path.
 * Without a scheme http is assumed, which on the local network is the only one the hub speaks.
 */
export function parseHubAddress(raw: string): HubAddress | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const https = url.protocol === "https:";
  // A public URL runs on 443 and the port is not written: appending it
  // («https://nome.trycloudflare.com:7420») would break the tunnel.
  const port = url.port || (https ? "" : DEFAULT_HUB_PORT);
  const authority = port ? `${url.hostname}:${port}` : url.hostname;
  return {
    base: `${url.protocol}//${authority}`,
    host: url.hostname,
    port: port || (https ? "443" : DEFAULT_HUB_PORT),
    https,
  };
}

/** Valid port to put in a URL: 1–65535, digits and nothing else. */
export function isValidPort(raw: string): boolean {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

/**
 * Address from the «IP» and «port» fields. Returns null when something is missing, so
 * the Connect button stays off instead of trying a malformed URL.
 */
export function hubBaseFromParts(host: string, port: string): string | null {
  const h = String(host ?? "").trim();
  if (!h) return null;
  const p = String(port ?? "").trim();
  if (!isValidPort(p)) return null;
  // Whoever pastes «http://192.168.1.20:7420» into the IP field means that:
  // the full address wins over the port written next to it.
  if (/^https?:\/\//i.test(h) || h.includes(":")) {
    const parsed = parseHubAddress(h);
    return parsed ? parsed.base : null;
  }
  return parseHubAddress(`${h}:${p}`)?.base ?? null;
}

/**
 * How to present a saved address: the tunnel goes in the public URL field,
 * the local network in the two IP and port fields.
 */
export function guessHubMode(raw: string): "local" | "public" {
  const parsed = parseHubAddress(raw);
  if (!parsed) return "local";
  return parsed.https ? "public" : "local";
}

/** What a hub QR carries: the hub origin and, when the panel included it, the access key. */
export type HubQr = { base: string; accessKey?: string };

/**
 * QR content → hub base (+ access key). The Network panel's QR contains the
 * URL in plain text, optionally with the key in the fragment
 * (`…/#rekordKey=…`, never sent to any server); a QR scanned in a hurry can
 * carry a path (`/admin`) or come from a panel that wraps the URL in JSON
 * (`{"url": …, "accessKey": …}`): in every case here we go back to the bare
 * origin. A malformed key is dropped, the address is kept.
 */
export function hubBaseFromQr(text: string): HubQr | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  let url: string;
  let key: string | null = null;
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const candidate = data.url ?? data.baseUrl ?? data.publicUrl ?? data.hub;
      if (typeof candidate !== "string") return null;
      url = candidate;
      if (typeof data.accessKey === "string" && isWellFormedAccessKey(data.accessKey.trim())) {
        key = data.accessKey.trim();
      }
    } catch {
      return null;
    }
  } else {
    url = raw;
  }
  const hash = url.indexOf("#");
  if (hash >= 0) {
    key ??= accessKeyFromFragment(url.slice(hash));
    url = url.slice(0, hash);
  }
  const base = parseHubAddress(url)?.base;
  if (!base) return null;
  return key ? { base, accessKey: key } : { base };
}

/** Short label for the «connecting to…» state: the scheme is not needed. */
export function formatHubLabel(raw: string): string {
  const parsed = parseHubAddress(raw);
  if (!parsed) return String(raw ?? "").trim();
  return parsed.base.replace(/^https?:\/\//i, "");
}
