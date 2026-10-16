/**
 * The JavaScript runtime the hub hands to yt-dlp (`binaries.jsRuntime` in the
 * diagnostics, `jsRuntime` in the download preset). YouTube refuses yt-dlp
 * without one ("The page needs to be reloaded" / sign-in request).
 */

export type JsRuntimeInfo = {
  /** The hub reports it (older hubs don't: no warning then). */
  known: boolean;
  available: boolean;
  /** yt-dlp name: `deno`, `node`, `bun`, `quickjs`. */
  name: string | null;
  version: string | null;
  /** Turned off on purpose (`REKORD_YTDLP_JS_RUNTIME=none`). */
  disabled: boolean;
};

const UNKNOWN: JsRuntimeInfo = {
  known: false,
  available: false,
  name: null,
  version: null,
  disabled: false,
};

export function pickJsRuntime(raw: unknown): JsRuntimeInfo {
  if (!raw || typeof raw !== "object") return UNKNOWN;
  const o = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = text(o.name);
  return {
    known: true,
    available: o.available === true && name != null,
    name,
    version: text(o.version),
    disabled: o.disabled === true,
  };
}

const LABELS: Record<string, string> = {
  deno: "Deno",
  node: "Node.js",
  bun: "Bun",
  quickjs: "QuickJS",
};

/** "QuickJS 0.17.0", "Node.js 22.16.0", "Deno". */
export function jsRuntimeLabel(info: Pick<JsRuntimeInfo, "name" | "version">): string {
  const base = info.name ? (LABELS[info.name] ?? info.name) : "?";
  return info.version ? `${base} ${info.version}` : base;
}

/** The hub said it has no runtime (and it was not turned off on purpose). */
export function jsRuntimeMissing(info: JsRuntimeInfo): boolean {
  return info.known && !info.available && !info.disabled;
}
