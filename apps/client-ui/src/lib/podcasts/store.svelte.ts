/**
 * Podcasts module, client side (lazy chunk: loaded only when the hub has
 * the module on and a podcast card / view / episode is shown).
 *
 * - Sources and latest episodes from `/api/v1/podcasts`, fetched when the
 *   card or view opens (or on "Aggiorna"); never polled.
 * - Per-account listening state (resume point, listened) in the synced user
 *   setting `podcasts`, merged entry by entry across devices.
 * - A tracker on the player's own events while an episode plays: no timer.
 */
import { request } from "../api/http";
import {
  isExternalTrack,
  makeExternalTrack,
  parseExternalPath,
} from "../externalItems";
import { player } from "../player";
import {
  SETTING_KEY,
  emptyState,
  entryId,
  episodeProgress,
  markListened,
  mergeStates,
  normalizeState,
  recordProgress,
  type EpisodeProgress,
  type PodcastEntry,
  type PodcastEpisode,
  type PodcastList,
  type PodcastSource,
  type PodcastState,
} from "../podcastModel";
import { session } from "../session.svelte";

/** A reopen within this window reuses the list (card + view in a row). */
const REUSE_MS = 60_000;
/** While an episode plays, its position is saved at most this often. */
const SAVE_EVERY_MS = 60_000;
/** The hub fetches stale sources before answering: give it time. */
const LIST_TIMEOUT_MS = 40_000;

class PodcastStore {
  sources = $state.raw<PodcastSource[]>([]);
  loaded = $state(false);
  loading = $state(false);
  /** Message of the last failed list request (sources keep their last value). */
  error = $state<string | null>(null);
  /** Show the podcasts view opens on (set by `openSource`, taken by the view). */
  requestedSource = $state<number | null>(null);

  private inflight: Promise<void> | null = null;
  private loadedAt = 0;
  private loadedAccount: string | null = null;
  private stateCache: { raw: unknown; state: PodcastState } | null = null;
  private trackerBound = false;
  /** Live position of the playing episode, committed every SAVE_EVERY_MS. */
  private pending: { id: string; pos: number; dur: number } | null = null;
  private lastSaveAt = 0;
  private lastPath: string | null = null;

  constructor() {
    // Pull / 409 rebase: combine both devices' entries (newest per episode).
    session.registerSyncedMerge(SETTING_KEY, (local, remote) => mergeStates(remote, local));
  }

  /** Sources and episodes; fetched again only when stale or `force`. */
  load(opts: { force?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight;
    const account = session.activeAccountId;
    const fresh =
      this.loaded && account === this.loadedAccount && Date.now() - this.loadedAt < REUSE_MS;
    if (fresh && !opts.force) return Promise.resolve();
    this.loading = true;
    const task = request<PodcastList>(`/api/v1/podcasts${opts.force ? "?refresh=1" : ""}`, {
      timeoutMs: LIST_TIMEOUT_MS,
    })
      .then((list) => {
        this.sources = Array.isArray(list?.sources) ? list.sources : [];
        this.error = null;
        this.loaded = true;
        this.loadedAt = Date.now();
        this.loadedAccount = account;
      })
      .catch((e: unknown) => {
        this.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.loading = false;
        this.inflight = null;
      });
    this.inflight = task;
    return task;
  }

  /** Go to the podcasts view, on the page of source `id`. */
  openSource(id: number) {
    this.requestedSource = id;
    session.navigate("podcasts");
  }

  // ---- Listening state -------------------------------------------------------

  /** This account's listening state (reactive through the synced setting). */
  get state(): PodcastState {
    const raw = session.syncedSetting(SETTING_KEY);
    const c = this.stateCache;
    if (c && c.raw === raw) return c.state;
    const state = raw == null ? emptyState() : normalizeState(raw);
    this.stateCache = { raw, state };
    return state;
  }

  private save(next: PodcastState) {
    this.stateCache = null;
    session.setSyncedSetting(SETTING_KEY, next);
  }

  entry(sourceId: number, key: string): PodcastEntry | null {
    return this.state.e[entryId(sourceId, key)] ?? null;
  }

  progress(source: PodcastSource, ep: PodcastEpisode): EpisodeProgress {
    return episodeProgress(this.entry(source.id, ep.key), ep.durationSecs);
  }

  setListened(source: PodcastSource, ep: PodcastEpisode, listened: boolean) {
    this.flushPending();
    this.save(
      markListened(
        this.state,
        {
          sourceId: source.id,
          key: ep.key,
          title: ep.title,
          sourceName: source.name,
          art: !!ep.hasArt,
        },
        listened,
      ),
    );
  }

  // ---- Playback --------------------------------------------------------------

  trackFor(source: PodcastSource, ep: PodcastEpisode) {
    return makeExternalTrack({
      sourceId: source.id,
      sourceName: source.name,
      key: ep.key,
      title: ep.title,
      live: source.live || !!ep.live,
      durationSecs: ep.durationSecs ?? null,
      publishedAt: ep.publishedAt ?? null,
      art: !!ep.hasArt,
      mime: ep.mime ?? null,
    });
  }

  isCurrent(source: PodcastSource, ep: PodcastEpisode): boolean {
    const p = parseExternalPath(player.current?.rel_path ?? "");
    return !!p && p.sourceId === source.id && p.key === ep.key;
  }

  /** Play now (resuming where it was left), or add to the queue. */
  play(source: PodcastSource, ep: PodcastEpisode, opts: { queue?: boolean } = {}) {
    this.bindTracker();
    const live = source.live || !!ep.live;
    if (!opts.queue && this.isCurrent(source, ep)) {
      if (!player.playing) void player.toggle();
      return;
    }
    const prog = this.progress(source, ep);
    player.playExternal(this.trackFor(source, ep), {
      startAt: live ? 0 : prog.resumeAt,
      queue: opts.queue,
    });
    if (!opts.queue) {
      // In the history at once, even before the first save.
      const pos = live ? 0 : prog.resumeAt;
      this.save(
        recordProgress(
          this.state,
          {
            sourceId: source.id,
            key: ep.key,
            title: ep.title,
            sourceName: source.name,
            art: !!ep.hasArt,
            live,
          },
          pos,
          ep.durationSecs ?? 0,
        ),
      );
    }
  }

  /**
   * Follow the player while an episode is current: position kept in memory
   * on every timeupdate, written to the account at most once a minute and
   * on pause / track change / leaving. Bound once, lives with the page.
   */
  bindTracker() {
    if (this.trackerBound || typeof window === "undefined") return;
    this.trackerBound = true;
    player.subscribeProgress(() => this.onProgress());
    player.subscribe(() => this.onStateChange());
    player.subscribePlayState(() => {
      if (!player.playing) this.flushPending();
    });
    window.addEventListener("pagehide", () => this.flushPending());
    this.lastPath = player.current?.rel_path ?? null;
  }

  private onProgress() {
    const cur = player.current;
    if (!cur || !isExternalTrack(cur) || cur.external?.kind === "live") return;
    const p = parseExternalPath(cur.rel_path);
    if (!p) return;
    // Only the episode really playing, at a position of its own: not while it
    // buffers (the previous item still sounds), not after a failed load (a
    // 502 from the feed), not mid-skip. A resume point never drops because of
    // those.
    const pos = player.positionOf(cur.rel_path);
    if (pos == null) return;
    const dur = player.duration > 0 ? player.duration : cur.duration_ms / 1000;
    this.pending = { id: entryId(p.sourceId, p.key), pos, dur };
    const now = Date.now();
    const ended = dur > 0 && pos >= dur - 1;
    if (ended || now - this.lastSaveAt >= SAVE_EVERY_MS) this.flushPending();
  }

  private onStateChange() {
    const path = player.current?.rel_path ?? null;
    if (path !== this.lastPath) {
      // Track changed: the previous episode's last position goes in now.
      this.flushPending();
      this.lastPath = path;
    }
  }

  private flushPending() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.lastSaveAt = Date.now();
    const [sid, key] = pending.id.split(":");
    const sourceId = Number(sid);
    if (!key || !Number.isFinite(sourceId)) return;
    const prev = this.state.e[pending.id];
    const source = this.sources.find((s) => s.id === sourceId);
    const ep = source?.episodes.find((e) => e.key === key);
    const cur = player.current;
    const curPath = cur ? parseExternalPath(cur.rel_path) : null;
    const fromPlayer = curPath && curPath.sourceId === sourceId && curPath.key === key ? cur : null;
    this.save(
      recordProgress(
        this.state,
        {
          sourceId,
          key,
          title: ep?.title ?? fromPlayer?.title ?? prev?.t ?? "",
          sourceName: source?.name ?? fromPlayer?.external?.sourceName ?? prev?.s ?? "",
          art: ep?.hasArt ?? fromPlayer?.external?.art ?? prev?.a ?? false,
        },
        pending.pos,
        pending.dur,
      ),
    );
  }
}

export const podcasts = new PodcastStore();
