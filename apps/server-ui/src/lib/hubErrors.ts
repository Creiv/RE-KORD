/**
 * Map a failed hub response to a locale key. The hub's own error sentences
 * are Italian-only or bare codes, so the panel recognises the ones it can
 * explain and falls back to the raw text otherwise. No Svelte / DOM here:
 * the node tests import this file directly.
 */

export type HubErrorKey = { key: string; vars?: Record<string, string | number> };

/** Hub codes of the podcasts module the panel explains in its own words. */
export const PODCAST_CODES: ReadonlySet<string> = new Set([
  "podcasts_disabled",
  "podcast_invalid_url",
  "url_not_allowed",
  "podcast_fetch_timeout",
  "podcast_fetch_failed",
  "podcast_http_error",
  "podcast_too_large",
  "podcast_parse_failed",
  "podcast_unsupported_url",
  "podcast_hls_unsupported",
  "podcast_no_episodes",
  "podcast_source_not_found",
  "podcast_episode_not_found",
  "podcast_resolve_failed",
  "podcast_proxy_busy",
  "podcast_limit_reached",
  "invalid_episode_count",
  "ytdlp_disabled",
  "ytdlp_not_found",
  "ytdlp_timeout",
  "ytdlp_failed",
]);

/** Hub codes of sleep prevention (`/system/power`), also shown in its status line. */
export const POWER_CODES: ReadonlySet<string> = new Set([
  "power_unsupported",
  "power_refused",
  "power_failed",
  "power_locked_by_env",
  "invalid_prevent_sleep",
  "settings_save_failed",
]);

/** Refused cookie uploads (`/config/youtube-cookies`). */
export const COOKIE_CODES: ReadonlySet<string> = new Set([
  "cookies_invalid",
  "cookies_json",
  "cookies_empty",
  "cookies_locked_by_env",
]);

/** Access key refusals (`REKORD_ACCESS_KEY`). */
export const ACCESS_KEY_CODES: ReadonlySet<string> = new Set([
  "access_key_required",
  "access_key_invalid",
  "access_key_rate_limited",
  "access_key_from_env",
  "access_key_weak",
]);

/** Statuses a reverse proxy (Vite dev, Cloudflare) answers for a hub that is down. */
export function isGatewayStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** True for a bare machine code such as `invalid_account_id`. */
function isBareCode(text: string): boolean {
  return /^[a-z0-9_]+$/.test(text);
}

/**
 * @param status HTTP status of the response
 * @param code   `error` field of the hub envelope, if any
 * @param hasBody whether a JSON body was read at all
 */
export function hubErrorKey(
  status: number,
  code: string | null,
  hasBody: boolean,
): HubErrorKey | null {
  const text = (code ?? "").toLowerCase();

  // Podcasts module codes (and the yt-dlp / SSRF ones its URLs can hit).
  if (code && PODCAST_CODES.has(code)) return { key: `errors.code.${code}` };
  if (code && POWER_CODES.has(code)) return { key: `errors.code.${code}` };
  if (code && COOKIE_CODES.has(code)) return { key: `errors.code.${code}` };
  if (code && ACCESS_KEY_CODES.has(code)) return { key: `errors.code.${code}` };

  if (status === 403) {
    if (text.includes("default")) return { key: "errors.forbiddenDefault" };
    if (
      text.includes("computer dell'hub") ||
      text.includes("hub's computer") ||
      text.includes("remot") ||
      text.includes("machine") ||
      text.includes("macchina")
    ) {
      return { key: "errors.forbiddenRemote" };
    }
    if (code && !isBareCode(code)) return { key: "errors.forbiddenDetail", vars: { detail: code } };
    return { key: "errors.forbidden" };
  }

  if (!hasBody && isGatewayStatus(status)) {
    return { key: "errors.unreachableStatus", vars: { status } };
  }
  if (!hasBody && status === 404) return { key: "errors.notAvailable" };

  if (text.includes("already in progress")) return { key: "errors.scanBusy" };
  if (text.includes("music_root not set")) return { key: "errors.musicRootNotSet" };
  if (text.includes("music root is not a directory")) return { key: "errors.musicRootMissing" };
  if (text === "legacy_data_not_found") return { key: "errors.legacyDataNotFound" };
  if (text === "account not found" || text === "account_not_found") {
    return { key: "errors.accountNotFound" };
  }
  if (status === 413) return { key: "errors.tooLarge" };

  return null;
}
