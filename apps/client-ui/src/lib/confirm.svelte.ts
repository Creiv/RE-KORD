/**
 * In-app replacement for `window.confirm()`.
 *
 * The native dialog blocks the WebView, ignores the theme and on Android shows
 * the page origin as its title. `confirmDialog()` queues a request that
 * `ConfirmHost` (mounted once in AppShell) renders with the shared Modal; the
 * promise resolves `true` only on an explicit confirm — Escape, Back, the ×, a
 * click outside or the host unmounting all count as "no".
 *
 * `confirmChoice()` is the two-way variant ("Continua" / "Apri il podcast"):
 * the second button is an answer of its own, distinct from dismissing.
 */

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: the confirm button is styled as danger. */
  danger?: boolean;
  /** Second answer, shown instead of "Cancel" (`confirmChoice` only). */
  altLabel?: string;
};

/** What the person picked; "cancel" = dismissed (Escape, ×, outside). */
export type ConfirmResult = "confirm" | "alt" | "cancel";

export type ConfirmRequest = ConfirmOptions & {
  id: number;
  resolve: (result: ConfirmResult) => void;
};

class ConfirmStore {
  /** FIFO: a second request waits until the first is answered. */
  queue = $state<ConfirmRequest[]>([]);
  /** Hosts currently mounted; with none we fall back to the native dialog. */
  hosts = 0;
  private nextId = 1;

  get current(): ConfirmRequest | null {
    return this.queue[0] ?? null;
  }

  request(opts: ConfirmOptions): Promise<ConfirmResult> {
    return new Promise<ConfirmResult>((resolve) => {
      this.queue = [...this.queue, { ...opts, id: this.nextId++, resolve }];
    });
  }

  /** Answer the request `id` (ignored when it was already answered). */
  settle(id: number, result: ConfirmResult) {
    const req = this.queue.find((r) => r.id === id);
    if (!req) return;
    this.queue = this.queue.filter((r) => r.id !== id);
    req.resolve(result);
  }

  /** Host going away: nobody can answer the pending ones any more. */
  cancelAll() {
    const pending = this.queue;
    this.queue = [];
    for (const r of pending) r.resolve("cancel");
  }
}

export const confirmStore = new ConfirmStore();

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return confirmChoice({ ...opts, altLabel: undefined }).then((r) => r === "confirm");
}

export function confirmChoice(opts: ConfirmOptions): Promise<ConfirmResult> {
  if (confirmStore.hosts <= 0) {
    // Before the shell is up (connect screen) there is no host to render into.
    const text = opts.message ? `${opts.title}\n\n${opts.message}` : opts.title;
    const ok = typeof window !== "undefined" && window.confirm(text);
    return Promise.resolve(ok ? "confirm" : "cancel");
  }
  return confirmStore.request(opts);
}
