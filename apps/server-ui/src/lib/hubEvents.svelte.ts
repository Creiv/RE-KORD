/**
 * The hub's event stream for the admin panel (`GET /api/v1/events`, hub ≥ 5.3):
 * `jobs` and `library` hints replace the 1.5 s polling while a job runs. Open
 * only while the page is visible; the browser reopens it after a drop, and
 * `connected` tells the store whether to poll instead.
 */
import { withAccessKeyQuery } from "./accessKey";

export type HubEventKind = "hello" | "jobs" | "library" | "userState" | "remoteAccess" | "downloads";

class HubEvents {
  connected = $state(false);
  private source: EventSource | null = null;
  private listener: ((kind: HubEventKind, data: Record<string, unknown>) => void) | null = null;

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.open();
        else this.close();
      });
    }
  }

  start(listener: (kind: HubEventKind, data: Record<string, unknown>) => void) {
    this.listener = listener;
    this.open();
  }

  /** The key changed: the open stream carries the old one. */
  restart() {
    this.close();
    this.open();
  }

  private open() {
    if (!this.listener || typeof EventSource === "undefined" || this.source) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    let es: EventSource;
    try {
      es = new EventSource(withAccessKeyQuery("/api/v1/events"));
    } catch {
      return;
    }
    this.source = es;
    for (const kind of ["hello", "jobs", "library", "userState", "remoteAccess", "downloads"] as const) {
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
        this.listener?.(kind, data);
      });
    }
    es.onerror = () => {
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
