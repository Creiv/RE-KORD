/** Cache breve: l'IP WAN cambia raramente ma non serve hammerare i provider. */
const CACHE_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 4500;

/** @type {{ ip: string | null, fetchedAt: number }} */
let cache = { ip: null, fetchedAt: 0 };

const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE =
  /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4})+(?:%[0-9a-z]+)?$/i;

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function parsePublicIp(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (j && typeof j.ip === "string") {
      const ip = j.ip.trim();
      if (IPV4_RE.test(ip) || IPV6_RE.test(ip)) return ip;
    }
  } catch {
    /* plain text */
  }
  const first = s.split(/\s+/)[0]?.trim() ?? "";
  if (IPV4_RE.test(first) || IPV6_RE.test(first)) return first;
  return null;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchLookupText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

const LOOKUP_URLS = [
  "https://api.ipify.org?format=json",
  "https://api64.ipify.org?format=json",
  "https://ifconfig.me/ip",
];

/**
 * IP pubblico WAN della rete dove gira il processo server (best-effort).
 * @returns {Promise<{ ip: string | null, cached?: boolean }>}
 */
export async function resolveServerPublicIp() {
  const now = Date.now();
  if (cache.ip && now - cache.fetchedAt < CACHE_MS) {
    return { ip: cache.ip, cached: true };
  }

  for (const url of LOOKUP_URLS) {
    try {
      const ip = parsePublicIp(await fetchLookupText(url));
      if (ip) {
        cache = { ip, fetchedAt: now };
        return { ip, cached: false };
      }
    } catch {
      /* prova provider successivo */
    }
  }

  cache = { ip: null, fetchedAt: now };
  return { ip: null };
}

/** Solo per test. */
export function resetPublicIpCacheForTests() {
  cache = { ip: null, fetchedAt: 0 };
}
