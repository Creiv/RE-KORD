/**
 * Hub calls used only by Studio (downloads, yt-dlp, curiosità, discover).
 *
 * Every wrapper here degrades when the hub is older than the client: an
 * endpoint that answers 404/405 resolves to `null` ("not supported") instead of
 * throwing, so the pane can hide the feature rather than show an error.
 */
import {
  ApiError,
  LONG_TIMEOUT_MS,
  fetchHub,
  forbiddenMessage,
  parseJsonBody,
  request,
  type Envelope,
  type RequestOptions,
} from "./http";
import { t } from "../i18n.svelte";

type CallOptions = Pick<RequestOptions, "signal" | "timeoutMs">;

/** 404/405 from a hub that predates the endpoint. */
export function isUnsupported(e: unknown): boolean {
  return e instanceof ApiError && e.kind === "http" && (e.status === 404 || e.status === 405);
}

async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (isUnsupported(e)) return null;
    throw e;
  }
}

/** Error of a streamed endpoint (no envelope reader in `request`). */
async function streamHttpError(r: Response): Promise<ApiError> {
  let env: Envelope<unknown> | null = null;
  try {
    env = (await r.json()) as Envelope<unknown>;
  } catch {
    /* not JSON */
  }
  const raw = env?.error as unknown;
  const code =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string"
        ? ((raw as { code: string }).code)
        : null;
  const message = r.status === 403 ? forbiddenMessage(code) : code || r.statusText || `HTTP ${r.status}`;
  return new ApiError("http", message, { status: r.status, code, body: env });
}

/** Read an NDJSON body line by line. */
async function readNdjson(res: Response, onLine: (obj: Record<string, unknown>) => void) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error(t("core.api.noStream"));
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* bad line: skip */
      }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      onLine(JSON.parse(tail) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
}

// ——— Downloads ———

export type DownloadFailedItem = { label: string; reason: string };

export type DownloadEvent = {
  type: string;
  progress?: { current: number; total: number } | null;
  ok?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  /** yt-dlp exit code (not an error code). */
  code?: number;
  /** Hub error code for the whole job (`no_audio_format`, …). */
  errorCode?: string;
  error?: string | { code?: string; message?: string };
  message?: string;
  /** Per-item summary (new hubs). */
  downloaded?: number;
  skipped?: number;
  failed?: number;
  downloadedItems?: string[];
  skippedItems?: DownloadFailedItem[];
  failedItems?: DownloadFailedItem[];
  /** Set once the hub has indexed the downloaded files. */
  indexEpoch?: number;
  musicRoot?: string;
  outputDir?: string;
  [key: string]: unknown;
};

export type DownloadRequest = {
  url: string;
  downloadId: string;
  downloadKind?: string;
  outputDir?: string;
};

/**
 * Start a yt-dlp job and stream its NDJSON events. No timer: a playlist runs
 * for many minutes; only `signal` ends it (and the hub then kills yt-dlp).
 */
export async function startDownloadStream(
  body: DownloadRequest,
  onEvent: (ev: DownloadEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchHub(
    "/api/v1/download",
    { method: "POST", body: JSON.stringify(body), signal, timeoutMs: null },
    async (r) => {
      if (r.ok) return r;
      throw await streamHttpError(r);
    },
  );
  await readNdjson(res, (obj) => onEvent(obj as DownloadEvent));
}

export function downloadCancel(downloadId: string) {
  return request<{ ok: boolean }>("/api/v1/download-cancel", {
    method: "POST",
    body: JSON.stringify({ downloadId }),
  });
}

/** `known: false` (with `error`) when yt-dlp could not count the entries. */
export function downloadFlatCount(url: string, opts?: CallOptions) {
  return request<{ count: number | null; known?: boolean; error?: string | null }>("/api/v1/download-flat-count", {
    method: "POST",
    body: JSON.stringify({ url }),
    timeoutMs: LONG_TIMEOUT_MS,
    ...opts,
  });
}

export type ActiveDownload = {
  downloadId: string;
  url?: string | null;
  kind?: string | null;
  outputDir?: string | null;
  startedAt?: string | null;
  progress?: { current: number; total: number } | null;
  /** `running`, `indexing`, `done`, `failed`, `cancelled` (null: old hub, running). */
  status?: string | null;
  canCancel?: boolean | null;
};

/** Still working (finished jobs stay listed for a while on new hubs). */
export function isActiveDownload(d: ActiveDownload): boolean {
  return !d.status || d.status === "running" || d.status === "indexing";
}

/** Downloads running on the hub (any client). `null`: hub does not say. */
export async function downloadActive(opts?: CallOptions): Promise<ActiveDownload[] | null> {
  return optional(async () => {
    const data = await request<unknown>("/api/v1/download/active", opts);
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object"
        ? ((data as { downloads?: unknown; active?: unknown; items?: unknown }).downloads ??
          (data as { active?: unknown }).active ??
          (data as { items?: unknown }).items)
        : null;
    if (!Array.isArray(list)) return [];
    return list
      .map((raw) => {
        if (typeof raw === "string") return { downloadId: raw } as ActiveDownload;
        const o = (raw ?? {}) as Record<string, unknown>;
        const id = String(o.downloadId ?? o.id ?? "");
        const prog = o.progress as { current?: unknown; total?: unknown } | null | undefined;
        return {
          downloadId: id,
          url: typeof o.url === "string" ? o.url : null,
          kind: typeof (o.kind ?? o.downloadKind) === "string" ? String(o.kind ?? o.downloadKind) : null,
          outputDir: typeof o.outputDir === "string" ? o.outputDir : null,
          startedAt: typeof o.startedAt === "string" ? o.startedAt : null,
          progress:
            prog && Number.isFinite(Number(prog.current)) && Number.isFinite(Number(prog.total))
              ? { current: Number(prog.current), total: Number(prog.total) }
              : null,
          status: typeof o.status === "string" ? o.status : null,
          canCancel: typeof o.canCancel === "boolean" ? o.canCancel : null,
        } satisfies ActiveDownload;
      })
      .filter((d) => d.downloadId);
  });
}

/**
 * Re-attach to a running job: a `snapshot` event, then live events up to
 * `done`. Throws `isUnsupported` on hubs without re-attach.
 */
export async function attachDownloadStream(
  downloadId: string,
  onEvent: (ev: DownloadEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ downloadId, stream: "1" });
  const res = await fetchHub(
    `/api/v1/download/active?${params}`,
    { signal, timeoutMs: null },
    async (r) => {
      if (r.ok) return r;
      throw await streamHttpError(r);
    },
  );
  await readNdjson(res, (obj) => onEvent(obj as DownloadEvent));
}

// ——— yt-dlp ———

export type YtdlpStatus = {
  available: boolean;
  version: string | null;
  /** Older than the hub's freshness window: YouTube likely broke it. */
  stale: boolean;
  /** Age in days, when the hub reports it. */
  ageDays: number | null;
  /** The hub can update it in place (`POST tools/ytdlp/update`). */
  updatable: boolean | null;
  /** Where the binary comes from (`bundled`, `path`, `custom`, …), never the path. */
  source: string | null;
};

function pickYtdlp(diag: unknown): YtdlpStatus | null {
  const d = (diag ?? {}) as Record<string, unknown>;
  const bins = (d.binaries ?? {}) as Record<string, unknown>;
  const y = (bins.ytdlp ?? d.ytdlp) as Record<string, unknown> | undefined;
  if (!y || typeof y !== "object") return null;
  const age = Number(y.ageDays ?? y.age_days);
  return {
    available: y.available !== false,
    version: typeof y.version === "string" && y.version.trim() ? y.version.trim() : null,
    stale: y.stale === true,
    ageDays: Number.isFinite(age) ? age : null,
    updatable:
      typeof y.updatable === "boolean"
        ? y.updatable
        : typeof y.canUpdate === "boolean"
          ? y.canUpdate
          : null,
    source: typeof y.source === "string" ? y.source : null,
  };
}

export async function ytdlpStatus(opts?: CallOptions): Promise<YtdlpStatus | null> {
  const diag = await request<unknown>("/api/v1/diagnostics", { timeoutMs: 30_000, ...opts });
  return pickYtdlp(diag);
}

export type YtdlpUpdateResult = {
  updated: boolean;
  upToDate: boolean;
  version: string | null;
  previousVersion: string | null;
};

/** `null`: the hub has no update endpoint. */
export async function ytdlpUpdate(): Promise<YtdlpUpdateResult | null> {
  return optional(async () => {
    const r = await request<Record<string, unknown> | null>("/api/v1/tools/ytdlp/update", {
      method: "POST",
      body: "{}",
      timeoutMs: 5 * 60_000,
    });
    const o = r ?? {};
    const version =
      typeof o.version === "string"
        ? o.version
        : typeof o.latestVersion === "string"
          ? o.latestVersion
          : null;
    const previous =
      typeof o.previousVersion === "string"
        ? o.previousVersion
        : typeof o.previous === "string"
          ? o.previous
          : null;
    return {
      updated: o.updated === true,
      upToDate: o.upToDate === true || o.updated !== true,
      version,
      previousVersion: previous,
    };
  });
}

// ——— Artist releases (streamed, with track counts) ———

export type ReleaseItem = { id: string; title: string; url: string; trackCount?: number | null };

export type ReleasesStreamHandlers = {
  onMeta?: (m: { listTitle: string; uploader: string; total: number }) => void;
  onEntry?: (e: ReleaseItem) => void;
  onListReady?: () => void;
  onPatch?: (e: ReleaseItem) => void;
};

function toRelease(raw: unknown): ReleaseItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = String(o.id ?? o.url ?? "");
  const url = String(o.url ?? "");
  if (!id || !url) return null;
  const n = o.trackCount ?? o.track_count;
  return {
    id,
    url,
    title: String(o.title ?? ""),
    trackCount: n == null || !Number.isFinite(Number(n)) ? null : Number(n),
  };
}

/**
 * Lists an artist's releases, then patches each with its track count. The list
 * is usable on `onListReady`; counts keep arriving until the promise resolves.
 */
export async function releasesListStream(
  url: string,
  handlers: ReleasesStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchHub(
    "/api/v1/youtube-releases-list",
    {
      method: "POST",
      body: JSON.stringify({ url, enrichCounts: true, stream: true }),
      signal,
      timeoutMs: null,
    },
    async (r) => {
      if (r.ok) return r;
      throw await streamHttpError(r);
    },
  );
  const type = res.headers.get("Content-Type") || "";
  if (!type.includes("ndjson")) {
    // Hub ignored `stream`: a plain envelope with the whole list.
    const env = await parseJsonBody<Envelope<{ listTitle?: string; uploader?: string; entries?: unknown[] }>>(res);
    if (!env.ok) throw new ApiError("http", String(env.error ?? ""), { status: res.status, code: String(env.error ?? "") });
    const data = env.data ?? {};
    const entries = (data.entries ?? []).map(toRelease).filter((e): e is ReleaseItem => !!e);
    handlers.onMeta?.({ listTitle: data.listTitle ?? "", uploader: data.uploader ?? "", total: entries.length });
    for (const e of entries) handlers.onEntry?.(e);
    handlers.onListReady?.();
    return;
  }
  let failure: ApiError | null = null;
  await readNdjson(res, (obj) => {
    switch (obj.type) {
      case "meta":
        handlers.onMeta?.({
          listTitle: String(obj.listTitle ?? ""),
          uploader: String(obj.uploader ?? ""),
          total: Number(obj.total ?? 0) || 0,
        });
        break;
      case "entry": {
        const e = toRelease(obj.entry);
        if (e) handlers.onEntry?.(e);
        break;
      }
      case "list_ready":
        handlers.onListReady?.();
        break;
      case "entry_patch": {
        const e = toRelease(obj.entry);
        if (e) handlers.onPatch?.(e);
        break;
      }
      case "error": {
        const code = typeof obj.code === "string" ? obj.code : null;
        failure = new ApiError("http", String(obj.message ?? code ?? ""), { status: 502, code });
        break;
      }
    }
  });
  if (failure) throw failure;
}

// ——— Curiosità (entity info) ———

export type EntityInfoSavedItem = {
  id: string;
  lang: string;
  title?: string | null;
  text: string;
  source?: string | null;
  url?: string | null;
  savedAt?: string;
};

export type EntityInfoSaved = {
  items: EntityInfoSavedItem[];
  image?: string | null;
};

export type EntityInfoCandidate = {
  /** Already saved for this target (hub dedupe by text). */
  alreadySaved?: boolean;
  id?: string | null;
  source?: string | null;
  kind?: string | null;
  lang?: string | null;
  title?: string | null;
  text: string;
  url?: string | null;
  imageUrl?: string | null;
};

/** Per-source outcome of a search (partial results are normal). */
export type EntityInfoSourceReport = {
  source: string;
  ok: boolean;
  count: number | null;
  code: string | null;
  message: string | null;
};

export type EntityInfoSearchResult = {
  candidates: EntityInfoCandidate[];
  sources: EntityInfoSourceReport[];
};

/** Saved items of an artist folder, or of `artistDir/albumDir`. Folder keys only. */
export function entityInfoGet(artistDir: string, albumDir?: string | null, opts?: CallOptions) {
  const params = new URLSearchParams({ artist: artistDir });
  if (albumDir) params.set("album", albumDir);
  return request<EntityInfoSaved>(`/api/v1/entity-info?${params}`, opts);
}

function normalizeSources(data: Record<string, unknown>): EntityInfoSourceReport[] {
  const out: EntityInfoSourceReport[] = [];
  const push = (source: string, v: Record<string, unknown>) => {
    const err = v.error as unknown;
    const code =
      typeof v.code === "string"
        ? v.code
        : typeof err === "string"
          ? err
          : err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
            ? (err as { code: string }).code
            : null;
    const message =
      typeof v.message === "string"
        ? v.message
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : null;
    const n = Number(v.count);
    out.push({
      source,
      ok: v.ok === true || (v.ok !== false && !code),
      count: Number.isFinite(n) ? n : null,
      code,
      message,
    });
  };
  const sources = data.sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const o = (s ?? {}) as Record<string, unknown>;
      push(String(o.source ?? o.name ?? "?"), o);
    }
  } else if (sources && typeof sources === "object") {
    for (const [k, v] of Object.entries(sources as Record<string, unknown>)) {
      push(k, (v ?? {}) as Record<string, unknown>);
    }
  }
  const errors = data.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      const o = (e ?? {}) as Record<string, unknown>;
      const source = String(o.source ?? o.name ?? "?");
      if (out.some((r) => r.source === source)) continue;
      push(source, { ...o, ok: false, code: o.code ?? o.error });
    }
  }
  return out;
}

/**
 * Search the web for curiosità. `artist`/`album` are display names (the query);
 * `artistDir`/`albumDir` are folder keys so the hub can flag saved duplicates.
 */
export async function entityInfoSearch(
  q: { artist: string; album?: string | null; artistDir?: string; albumDir?: string | null; lang: string },
  opts?: CallOptions,
): Promise<EntityInfoSearchResult> {
  const data = await request<Record<string, unknown>>("/api/v1/entity-info/search", {
    method: "POST",
    body: JSON.stringify({
      artist: q.artist,
      album: q.album || undefined,
      folderArtist: q.artistDir || undefined,
      folderAlbum: q.albumDir || undefined,
      lang: q.lang,
    }),
    timeoutMs: LONG_TIMEOUT_MS,
    ...opts,
  });
  const list = Array.isArray(data?.candidates) ? (data.candidates as Record<string, unknown>[]) : [];
  const candidates = list
    .map((c) => ({
      alreadySaved: c.alreadySaved === true || c.saved === true,
      id: typeof c.id === "string" ? c.id : null,
      source: typeof c.source === "string" ? c.source : null,
      kind: typeof c.kind === "string" ? c.kind : null,
      lang: typeof c.lang === "string" ? c.lang : null,
      title: typeof c.title === "string" ? c.title : null,
      text: typeof c.text === "string" ? c.text : "",
      url: typeof c.url === "string" ? c.url : null,
      imageUrl:
        typeof c.imageUrl === "string"
          ? c.imageUrl
          : typeof c.thumbnail === "string"
            ? c.thumbnail
            : null,
    }))
    .filter((c) => c.text.trim());
  // Sources that answered are only implied by their candidates: count them.
  const sources = normalizeSources(data ?? {});
  const counts = new Map<string, number>();
  for (const c of candidates) if (c.source) counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
  for (const [source, count] of counts) {
    if (!sources.some((r) => r.source === source)) {
      sources.unshift({ source, ok: true, count, code: null, message: null });
    }
  }
  return { candidates, sources };
}

export type EntityInfoSaveBody = {
  /** Artist folder key. */
  artist: string;
  /** Album folder (path under the artist folder), null for the artist. */
  album?: string | null;
  add?: Array<{ lang: string; title?: string | null; text: string; source?: string | null; url?: string | null }>;
  removeIds?: string[];
  /** In-place edits of saved items. */
  edit?: Array<{ id: string; title?: string | null; text: string }>;
  /** Artist photo from a candidate thumbnail. */
  imageUrl?: string | null;
};

export function entityInfoSave(body: EntityInfoSaveBody) {
  return request<EntityInfoSaved & { added?: number; duplicates?: number }>(
    "/api/v1/entity-info/save",
    { method: "POST", body: JSON.stringify(body), timeoutMs: LONG_TIMEOUT_MS },
  );
}

// ——— Discover (web catalog) ———

export type DiscoverItem = {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  thumbnailUrl?: string | null;
  kind?: string | null;
};

export type DiscoverResult = {
  albums: DiscoverItem[];
  songs: DiscoverItem[];
  /** Structured error from the hub (feed down, quota…), even with partial data. */
  error: { code: string | null; message: string | null } | null;
  /** Singles were recovered from the albums feed: the singles feed error is moot. */
  singlesRecovered: boolean;
};

function toDiscoverItem(raw: unknown): DiscoverItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url : "";
  if (!url) return null;
  return {
    id: String(o.id ?? url),
    title: String(o.title ?? ""),
    subtitle: String(o.subtitle ?? ""),
    url,
    thumbnailUrl: typeof o.thumbnailUrl === "string" ? o.thumbnailUrl : null,
    kind: typeof o.kind === "string" ? o.kind : null,
  };
}

/** Error field as the hub sends it: a string, a code, or `{ code, message }`. */
export function structuredError(raw: unknown): { code: string | null; message: string | null } | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    return /^[a-z0-9_]+$/.test(raw) ? { code: raw, message: null } : { code: null, message: raw };
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : null;
    const message = typeof o.message === "string" ? o.message : null;
    return code || message ? { code, message } : null;
  }
  return null;
}

export async function catalogDiscover(
  force: boolean,
  lang: string,
  opts?: CallOptions,
): Promise<DiscoverResult> {
  const params = new URLSearchParams({ hl: lang });
  if (force) params.set("force", "1");
  const data = await request<Record<string, unknown>>(`/api/v1/catalog-web-discover?${params}`, {
    timeoutMs: LONG_TIMEOUT_MS,
    ...opts,
  });
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).map(toDiscoverItem).filter((x): x is DiscoverItem => !!x);
  const singlesRecovered = data?.singlesRecovered === true;
  // Per-feed errors: a singles failure that was recovered is not worth a warning.
  const feedErrors = (Array.isArray(data?.errors) ? data.errors : []) as Array<Record<string, unknown>>;
  const relevant = feedErrors.filter((e) => !(singlesRecovered && e.feed === "singles"));
  const first = relevant[0];
  const error = first
    ? structuredError({ code: first.code, message: first.message })
    : feedErrors.length
      ? null
      : structuredError(data?.error ?? data?.errorCode);
  return {
    albums: list(data?.albums),
    songs: list(data?.songs ?? data?.singles),
    error,
    singlesRecovered,
  };
}
