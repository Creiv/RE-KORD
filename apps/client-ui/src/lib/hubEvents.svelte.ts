/**
 * The hub's event stream (`GET /api/v1/events`, server-sent events, hub ≥ 5.3).
 *
 * A hint channel: each event names what changed (`jobs`, `library`,
 * `userState`, `remoteAccess`, `downloads`) and the listeners re-read what
 * they show. Open only while the page is visible (nothing runs in the
 * background), reopened by the browser itself after a drop; `connected` tells
 * the polling loops they can stand down. The access key, when there is one,
 * travels in the URL like for `<audio>` (EventSource cannot send headers).
 */
import { apiUrl, getServerBaseUrl } from "./config";
import { isAccessKeyRefused } from "./accessKey";

export type HubEventKind = "hello" | "jobs" | "library" | "userState" | "remoteAccess" | "downloads";
export type HubEventHandler = (kind: HubEventKind, data: Record<string, unknown>) => void;

const KINDS: HubEventKind[] = ["hello", "jobs", "library", "userState", "remoteAccess", "downloads"];

class HubEvents {
  /** The stream is open and the hub said hello. */
  connected = $state(false);
  private source: EventSource | null = null;
  private handlers = new Set<HubEventHandler>();
  private wanted = false;
  private base = "";

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.open();
        else this.close();
      });
    }
  }

  /** Subscribe; returns the unsubscribe function. */
  on(fn: HubEventHandler): () => void {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  /** Keep a stream to the current hub while the page is visible. */
  start() {
    this.wanted = true;
    this.open();
  }

  stop() {
    this.wanted = false;
    this.close();
  }

  /** The hub address changed: a stream to the old one is useless. */
  rebind() {
    if (!this.wanted) return;
    this.close();
    this.open();
  }

  private open() {
    if (!this.wanted || typeof EventSource === "undefined") return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const base = getServerBaseUrl();
    if (this.source && this.base === base) return;
    this.close();
    if (isAccessKeyRefused(base)) return;
    let es: EventSource;
    try {
      es = new EventSource(apiUrl("/api/v1/events"));
    } catch {
      return;
    }
    this.base = base;
    this.source = es;
    for (const kind of KINDS) {
      es.addEventListener(kind, (ev) => {
        if (this.source !== es) return;
        if (kind === "hello") this.connected = true;
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse((ev as MessageEvent<string>).data);
          if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
        } catch {
          /* a hint without a body still counts */
        }
        for (const fn of this.handlers) {
          try {
            fn(kind, data);
          } catch {
            /* one listener must not break the others */
          }
        }
      });
    }
    es.onerror = () => {
      // The browser retries by itself; meanwhile the polling loops take over.
      if (this.source === es) this.connected = false;
    };
  }

  private close() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }
}

export const hubEvents = new HubEvents();
