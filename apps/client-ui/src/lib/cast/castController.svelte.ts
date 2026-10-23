/**
 * Casting controller: owns the active `CastBackend` and keeps the local player
 * and the receiver in step.
 *
 * While connected the player runs with a remote output
 * (`player.setRemoteOutput`): it keeps the queue and the state (play/pause,
 * position, duration — mirrored from the receiver, so every view follows the
 * cast), never starts local audio, and hands track loads / play / pause / seek
 * to this controller. When the receiver finishes a track the queue advances
 * (`player.notifyRemoteEnded`). Disconnecting removes the output and the player
 * resumes locally at the receiver's last position.
 *
 * ## Plugging another backend (e.g. native Android Cast)
 *
 *     import { registerCastBackend } from "./lib/cast/castController.svelte";
 *     registerCastBackend(new AndroidCastBackend()); // implements CastBackend
 *
 * Call it early (before the dock mounts) or any time later: the controller
 * drops the previous backend and re-initialises. Pass `null` to go back to the
 * default: the native Android backend (`androidCast.ts`) when the shell exposes
 * `window.RekordCastNative`, else the Google Cast Web Sender in Chrome-family
 * browsers, nothing elsewhere.
 */

import { acknowledgeCastWarning, castWarningAcknowledged, getAccessKey } from "../accessKey";
import { api, type Track } from "../api";
import { getServerBaseUrl } from "../config";
import { confirmDialog } from "../confirm.svelte";
import { t } from "../i18n.svelte";
import { player } from "../player";
import { toasts } from "../toasts.svelte";
import { createAndroidCastBackend } from "./androidCast";
import { CastLoadGate } from "./castLoadGate";
import { buildCastLoadPlan, resolveCastMediaBaseUrl, withCastAccessKey } from "./castMedia";
import { GoogleCastWebBackend } from "./googleCast";
import { INITIAL_CAST_STATUS, type CastBackend, type CastStatus } from "./types";

const HUB_INFO_TTL_MS = 60_000;

/** Native Cast in the Android shell (bridge present), else the web sender. */
function defaultBackend(): CastBackend {
  return (
    createAndroidCastBackend({
      sessionFailed: (code) => t("cast.sessionFailed", { code: code ?? "?" }),
      timeout: () => t("cast.timeout"),
    }) ?? new GoogleCastWebBackend()
  );
}

function hubTranscodeFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw && typeof raw === "object") {
    const o = raw as { available?: unknown; ok?: unknown; enabled?: unknown };
    return o.available === true || o.ok === true || o.enabled === true;
  }
  return false;
}

class CastController {
  /** Latest receiver status (replaced wholesale on every update). */
  status = $state.raw<CastStatus>({ ...INITIAL_CAST_STATUS });
  /** Backend works here and has (or may find) receivers: show the Cast button. */
  supported = $state(false);
  busy = $state(false);

  readonly available = $derived(this.supported && this.status.session !== "unavailable");
  readonly connected = $derived(this.status.session === "connected");
  readonly remotePlaying = $derived(
    this.status.session === "connected" &&
      (this.status.player === "playing" ||
        this.status.player === "buffering" ||
        this.status.player === "loading"),
  );

  private backend: CastBackend | null = null;
  private customBackend: CastBackend | null = null;
  private unsubBackend: (() => void) | null = null;
  private initGen = 0;
  private wasConnected = false;
  private loadedRelPath: string | null = null;
  /** Holds receiver statuses back until it acknowledged our latest load. */
  private loadGate = new CastLoadGate();
  private hubInfo: { at: number; base: string | null; transcode: boolean } | null = null;

  /** Idempotent: picks the backend and starts listening. Safe to call from any mount. */
  init(): void {
    if (this.backend) return;
    void this.activate(this.customBackend ?? defaultBackend());
  }

  /** See module doc: swap the backend (null → default web sender). */
  setBackend(next: CastBackend | null): void {
    this.customBackend = next;
    this.teardownBackend();
    void this.activate(next ?? defaultBackend());
  }

  private teardownBackend() {
    this.initGen += 1;
    this.unsubBackend?.();
    this.unsubBackend = null;
    if (this.wasConnected) this.onDisconnected();
    this.backend = null;
    this.supported = false;
    this.status = { ...INITIAL_CAST_STATUS };
  }

  private async activate(backend: CastBackend) {
    const gen = ++this.initGen;
    this.backend = backend;
    let ok = false;
    try {
      ok = await backend.isAvailable();
    } catch {
      ok = false;
    }
    if (gen !== this.initGen) return;
    this.supported = ok;
    if (!ok) return;
    this.unsubBackend = backend.subscribe((s) => this.onStatus(s));
    this.onStatus(backend.getStatus());
  }

  private onStatus(s: CastStatus) {
    this.status = s;
    const connected = s.session === "connected";
    if (connected && !this.wasConnected) {
      this.wasConnected = true;
      this.onConnected();
    } else if (!connected && this.wasConnected) {
      this.wasConnected = false;
      this.onDisconnected();
    } else if (connected) {
      this.mirrorToPlayer(s);
      this.maybeAdvanceOnFinish(s);
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (!this.backend || this.busy) return;
    this.busy = true;
    try {
      if (!(await this.confirmKeyGoesToDevice())) return;
      await this.backend.requestSession();
    } catch (e) {
      // Closing the device picker rejects with "cancel": not an error for the user.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) toasts.error(t("cast.connectFailed", { error: msg }));
    } finally {
      this.busy = false;
    }
  }

  async disconnect(): Promise<void> {
    await this.backend?.endSession(true);
  }

  /**
   * The receiver loads the hub's URLs itself, so with an access key the key
   * travels to the Cast device. Said once per hub and key, before the first
   * cast; a new key asks again.
   */
  private async confirmKeyGoesToDevice(): Promise<boolean> {
    const base = getServerBaseUrl();
    if (!getAccessKey(base) || castWarningAcknowledged(base)) return true;
    const ok = await confirmDialog({
      title: t("cast.keyWarnTitle"),
      message: t("cast.keyWarnBody"),
      confirmLabel: t("cast.keyWarnConfirm"),
    });
    if (ok) acknowledgeCastWarning(base);
    return ok;
  }

  private onConnected() {
    this.loadedRelPath = null;
    this.loadGate.reset();
    // Hands over the current track at the current position (see player.setRemoteOutput).
    player.setRemoteOutput({
      loadTrack: (track, startTime, autoplay) => void this.loadTrack(track, startTime, autoplay),
      play: () => void this.play(),
      pause: () => void this.backend?.pause(),
      seek: (seconds) => void this.backend?.seek(seconds),
    });
    const name = this.status.deviceName;
    toasts.info(name ? t("cast.connectedTo", { name }) : t("cast.connected"));
  }

  private onDisconnected() {
    this.loadedRelPath = null;
    this.loadGate.reset();
    // The player resumes locally from the last state the receiver reported.
    player.setRemoteOutput(null);
  }

  /** Receiver status → player state (position, play state, duration). */
  private mirrorToPlayer(s: CastStatus) {
    // Before our media is on the receiver its status is about something else.
    if (!this.loadedRelPath || (s.player === "idle" && s.idleReason == null)) return;
    // Still the previous media (old position / duration, or its "finished").
    if (!this.loadGate.settled) return;
    player.reportRemoteState({
      playing: s.player === "playing" || s.player === "buffering" || s.player === "loading",
      currentTime: s.currentTime,
      duration: s.duration,
    });
  }

  private async hubMediaInfo(): Promise<{ base: string | null; transcode: boolean }> {
    const cached = this.hubInfo;
    if (cached && Date.now() - cached.at < HUB_INFO_TTL_MS) return cached;
    const hubOrigin =
      getServerBaseUrl() || (typeof location !== "undefined" ? location.origin : "");
    // Hub addressed by a non-loopback origin (LAN IP, tunnel): the receiver can use it as is.
    const direct = resolveCastMediaBaseUrl({ hubOrigin });
    const [remote, health] = await Promise.all([
      direct ? Promise.resolve(null) : api.remoteAccess().catch(() => null),
      api.health().catch(() => null),
    ]);
    const base =
      direct ??
      resolveCastMediaBaseUrl({
        hubOrigin,
        lanUrl: remote?.lanUrl ?? null,
        publicUrl: remote?.publicUrl ?? null,
      });
    const info = { at: Date.now(), base, transcode: hubTranscodeFlag(health?.transcode) };
    this.hubInfo = info;
    return info;
  }

  private async loadTrack(track: Track, startTime: number, autoplay: boolean) {
    const backend = this.backend;
    if (!backend) return;
    this.loadedRelPath = track.rel_path;
    const token = this.loadGate.begin();
    const info = await this.hubMediaInfo();
    if (!this.loadGate.isCurrent(token) || !this.connected) return;
    if (!info.base) {
      this.loadGate.settle(token, false);
      toasts.error(t("cast.noLanUrl"));
      return;
    }
    const plan = withCastAccessKey(
      buildCastLoadPlan(track, info.base, { transcodeAvailable: info.transcode }),
      info.base,
      getAccessKey(getServerBaseUrl()),
    );
    try {
      await backend.loadMedia(plan.url, plan.contentType, plan.metadata, { startTime, autoplay });
      this.loadGate.settle(token, true);
    } catch (e) {
      if (!this.loadGate.isCurrent(token)) return;
      this.loadGate.settle(token, false);
      toasts.error(t("cast.loadFailed", { title: track.title, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Receiver finished the track: the player advances the queue (and calls loadTrack). */
  private maybeAdvanceOnFinish(s: CastStatus) {
    if (!this.loadedRelPath || !this.loadGate.takeFinish(s)) return;
    player.notifyRemoteEnded();
  }

  /** Play on the receiver; reload the current track if nothing is loaded (e.g. after it finished). */
  private async play(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    const s = this.status;
    if (s.player === "idle") {
      const cur = player.current;
      if (cur) await this.loadTrack(cur, s.idleReason === "finished" ? 0 : player.currentTime, true);
      return;
    }
    await backend.play();
  }
}

export const castController = new CastController();

/**
 * Install a casting backend (e.g. a native Android one); `null` restores the
 * default Google Cast Web Sender. See the module doc.
 */
export function registerCastBackend(backend: CastBackend | null): void {
  castController.setBackend(backend);
}
