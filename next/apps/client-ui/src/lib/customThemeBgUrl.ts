import { apiUrl } from "./config";

/** Read session account without importing account.ts (avoids userPrefs cycle). */
function activeAccountId(): string | null {
  try {
    return (
      localStorage.getItem("rekord.next.sessionAccountId") ||
      localStorage.getItem("rekord-session-account-id") ||
      null
    );
  } catch {
    return null;
  }
}

/** Cache-busted URL for the active account's custom theme background. */
export function customThemeBgImageUrl(rev?: number): string {
  const params = new URLSearchParams();
  if (rev != null && Number.isFinite(rev)) params.set("v", String(Math.floor(rev)));
  const id = activeAccountId();
  if (id) params.set("accountId", id);
  const q = params.toString();
  return apiUrl(`/api/v1/user-state/custom-theme-bg${q ? `?${q}` : ""}`);
}
