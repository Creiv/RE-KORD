/**
 * Transient notifications.
 *
 * Two shapes share one stack: timed toasts for something that happened, and
 * sticky "busy" toasts for something still running (library sync), which the
 * caller closes with a result. Sticky ones never expire on their own, so a slow
 * hub cannot leave the user thinking the work finished.
 */

export type ToastTone = "ok" | "error" | "info";

export type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
  /** Sticky while true: shows a spinner and ignores the timeout. */
  busy: boolean;
  /** How many times the same message arrived while still on screen. */
  count: number;
};

export type ToastOptions = {
  tone?: ToastTone;
  /** Milliseconds on screen; `null` keeps it until dismissed. */
  duration?: number | null;
  /** Replaces the toast with the same key instead of stacking a copy. */
  key?: string;
};

/** A running operation the user should keep seeing until it resolves. */
export type BusyToast = {
  update: (message: string) => void;
  /** Swaps the spinner for a result, which then expires normally. */
  done: (message: string, tone?: ToastTone) => void;
  dismiss: () => void;
};

const MAX_VISIBLE = 4;
const DEFAULT_MS = 3800;
/** Failures get longer: they carry text worth reading. */
const ERROR_MS = 6500;

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = String(e);
  return s === "[object Object]" ? "Errore inatteso" : s;
}

type Countdown = {
  /** Null while frozen by a hover. */
  handle: ReturnType<typeof setTimeout> | null;
  /** Left to run, kept so hovering can freeze and resume the countdown. */
  remaining: number;
  startedAt: number;
};

class ToastStore {
  items = $state<Toast[]>([]);

  private nextId = 1;
  private timers = new Map<number, Countdown>();
  private byKey = new Map<string, number>();
  private keyOf = new Map<number, string>();
  private paused = false;

  show(message: string, options: ToastOptions = {}): number {
    const text = message.trim();
    if (!text) return -1;
    const tone = options.tone ?? "info";
    const duration =
      options.duration === undefined
        ? tone === "error"
          ? ERROR_MS
          : DEFAULT_MS
        : options.duration;

    const existingId = options.key ? this.byKey.get(options.key) : undefined;
    if (existingId != null) {
      this.items = this.items.map((t) =>
        t.id === existingId
          ? { ...t, message: text, tone, busy: false, count: 1 }
          : t,
      );
      this.arm(existingId, duration);
      return existingId;
    }

    // A repeated action (retrying a failing one) counts up instead of stacking
    // four copies of the same sentence.
    const twin = this.items.find(
      (t) => !t.busy && t.tone === tone && t.message === text,
    );
    if (twin) {
      this.items = this.items.map((t) =>
        t.id === twin.id ? { ...t, count: t.count + 1 } : t,
      );
      this.arm(twin.id, duration);
      return twin.id;
    }

    const id = this.nextId++;
    this.items = [...this.items, { id, message: text, tone, busy: false, count: 1 }];
    if (options.key) {
      this.byKey.set(options.key, id);
      this.keyOf.set(id, options.key);
    }
    this.arm(id, duration);
    this.trim();
    return id;
  }

  ok(message: string, options?: Omit<ToastOptions, "tone">) {
    return this.show(message, { ...options, tone: "ok" });
  }

  info(message: string, options?: Omit<ToastOptions, "tone">) {
    return this.show(message, { ...options, tone: "info" });
  }

  error(message: string, options?: Omit<ToastOptions, "tone">) {
    return this.show(message, { ...options, tone: "error" });
  }

  /** Error toast from a caught value, without repeating the formatting. */
  fail(e: unknown, options?: Omit<ToastOptions, "tone">) {
    return this.error(describeError(e), options);
  }

  busy(message: string, key?: string): BusyToast {
    const id = this.show(message, { tone: "info", duration: null, key });
    this.items = this.items.map((t) => (t.id === id ? { ...t, busy: true } : t));
    return {
      update: (next: string) => {
        const text = next.trim();
        if (!text) return;
        this.items = this.items.map((t) =>
          t.id === id ? { ...t, message: text } : t,
        );
      },
      done: (next: string, tone: ToastTone = "ok") => {
        if (!this.items.some((t) => t.id === id)) {
          this.show(next, { tone });
          return;
        }
        const text = next.trim();
        if (!text) {
          this.dismiss(id);
          return;
        }
        this.items = this.items.map((t) =>
          t.id === id ? { ...t, message: text, tone, busy: false, count: 1 } : t,
        );
        this.arm(id, tone === "error" ? ERROR_MS : DEFAULT_MS);
      },
      dismiss: () => this.dismiss(id),
    };
  }

  dismiss(id: number) {
    this.clearTimer(id);
    const key = this.keyOf.get(id);
    if (key) {
      this.byKey.delete(key);
      this.keyOf.delete(id);
    }
    this.items = this.items.filter((t) => t.id !== id);
  }

  clear() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    this.byKey.clear();
    this.keyOf.clear();
    this.items = [];
  }

  /** Reading a toast must not race its timeout. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    for (const [id, timer] of [...this.timers]) {
      if (timer.handle != null) clearTimeout(timer.handle);
      const left = timer.remaining - (Date.now() - timer.startedAt);
      this.timers.set(id, {
        handle: null,
        remaining: Math.max(400, left),
        startedAt: Date.now(),
      });
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const [id, timer] of [...this.timers]) {
      this.timers.set(id, {
        handle: setTimeout(() => this.dismiss(id), timer.remaining),
        remaining: timer.remaining,
        startedAt: Date.now(),
      });
    }
  }

  private arm(id: number, duration: number | null) {
    this.clearTimer(id);
    if (duration == null) return;
    // Frozen while the pointer is over the stack; `resume` starts the countdown.
    this.timers.set(id, {
      handle: this.paused ? null : setTimeout(() => this.dismiss(id), duration),
      remaining: duration,
      startedAt: Date.now(),
    });
  }

  private clearTimer(id: number) {
    const timer = this.timers.get(id);
    if (!timer) return;
    if (timer.handle != null) clearTimeout(timer.handle);
    this.timers.delete(id);
  }

  /** Oldest timed toasts go first; a running operation is never pushed out. */
  private trim() {
    if (this.items.length <= MAX_VISIBLE) return;
    const excess = this.items.length - MAX_VISIBLE;
    const doomed = this.items.filter((t) => !t.busy).slice(0, excess);
    for (const t of doomed) this.dismiss(t.id);
  }
}

export const toasts = new ToastStore();
