/** Local multi-account session (parity with old `rekord-session-account-id`). */

const SESSION_KEY = "rekord.next.sessionAccountId";
const LEGACY_KEYS = [
  "rekord-session-account-id",
  "rekord-active-account-id",
  "kord-session-account-id",
  "kord-active-account-id",
];

export type Account = { id: string; name: string };

export type AccountsResponse = {
  defaultAccountId: string;
  accounts: Account[];
  createdAccountId?: string;
};

export function getSelectedAccountId(): string | null {
  try {
    const cur = localStorage.getItem(SESSION_KEY);
    if (cur) return cur;
    for (const k of LEGACY_KEYS) {
      const v = localStorage.getItem(k);
      if (v) {
        localStorage.setItem(SESSION_KEY, v);
        return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function setSelectedAccountId(id: string) {
  try {
    localStorage.setItem(SESSION_KEY, id);
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    window.dispatchEvent(
      new CustomEvent("rekord-account-session-changed", { detail: { accountId: id } }),
    );
  } catch {
    /* ignore */
  }
}

export function rememberAvailableAccount(data: AccountsResponse) {
  const current = getSelectedAccountId();
  if (current && data.accounts.some((a) => a.id === current)) return;
  const fallback = data.defaultAccountId || data.accounts[0]?.id;
  if (fallback) setSelectedAccountId(fallback);
}

export function accountHeaders(base: HeadersInit = {}): HeadersInit {
  const id = getSelectedAccountId();
  if (!id) return base;
  if (base instanceof Headers) {
    if (!base.has("X-KORD-Account-Id")) base.set("X-KORD-Account-Id", id);
    return base;
  }
  if (Array.isArray(base)) {
    return [...base, ["X-KORD-Account-Id", id]];
  }
  return { ...base, "X-KORD-Account-Id": id };
}

/** Append accountId query when missing (compat with old clients / proxies). */
export function withAccountQuery(path: string): string {
  const id = getSelectedAccountId();
  if (!id) return path;
  const qIndex = path.indexOf("?");
  const base = qIndex >= 0 ? path.slice(0, qIndex) : path;
  const params = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : "");
  if (!params.has("accountId") && !base.includes("/accounts")) {
    params.set("accountId", id);
  }
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}
