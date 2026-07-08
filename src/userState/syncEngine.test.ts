import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { patchUserState } from "../lib/api";
import {
  FLUSH_DELAY_DEFAULT_MS,
  FLUSH_DELAY_QUEUE_MS,
} from "../lib/userStatePatch";
import type { UserStateV1 } from "../types";
import { createUserStateSyncEngine } from "./syncEngine";

vi.mock("../lib/api", () => ({
  fetchUserState: vi.fn(),
  isBackendUnreachableError: (err: unknown) =>
    err instanceof Error && err.message === "BACKEND_UNREACHABLE",
  patchUserState: vi.fn(),
}));

function baseState(): UserStateV1 {
  return {
    version: 1,
    revision: 2,
    favorites: [],
    recent: [],
    trackPlayCounts: {},
    playlists: [],
    queue: { tracks: [], currentIndex: 0 },
    settings: {
      theme: "midnight",
      customTheme: {
        bg: "#0b1220",
        section: "#111827",
        accent: "#3b82f6",
        accent2: "#8b5cf6",
        bgMode: "color",
        bgImageFit: "cover",
      },
      vizMode: "hmb",
      restoreSession: true,
      defaultTab: "dashboard",
      locale: "en",
      libBrowse: "artists",
      libOverviewSort: "name",
      artistAlbumSort: "date",
      audioCrossfadeSec: 3,
      plectrDisableVizBackdrop: false,
      glassSurfaces: false,
      glassOpacity: 62,
    },
    shuffleExcludedAlbumIds: [],
    shuffleExcludedTrackRelPaths: [],
  };
}

function identityNormalize(s: UserStateV1): UserStateV1 {
  return s;
}

describe("createUserStateSyncEngine", () => {
  let state: UserStateV1;
  let setState: ReturnType<typeof vi.fn>;
  let setSaving: ReturnType<typeof vi.fn>;
  let setError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    state = baseState();
    setState = vi.fn((updater: (prev: UserStateV1) => UserStateV1) => {
      state = updater(state);
    });
    setSaving = vi.fn();
    setError = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine() {
    return createUserStateSyncEngine({
      setState: setState as React.Dispatch<React.SetStateAction<UserStateV1>>,
      setSaving: setSaving as React.Dispatch<React.SetStateAction<boolean>>,
      setError: setError as React.Dispatch<React.SetStateAction<string | null>>,
      beginLibrarySyncActivity: () => () => {},
      normalizeUserState: identityNormalize,
      mergeLegacy: (remote) => remote as UserStateV1,
      applyUserStatePatchLocal: (base, patch) =>
        ({ ...base, ...patch }) as UserStateV1,
      userStateToPatch: (s) => ({ favorites: s.favorites }),
    });
  }

  it("commit marks dirty and accumulates pending favorites patch", () => {
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.commit((prev) => ({ ...prev, favorites: ["a.mp3"] }));
    expect(engine.dirtyRef.current).toBe(true);
    expect(engine.pendingPatchRef.current.favorites).toEqual(["a.mp3"]);
  });

  it("enqueueQueuePatch stores queue in ref without setState", () => {
    const engine = createEngine();
    engine.hydratedRef.current = true;
    const queue = {
      tracks: [
        {
          id: "1",
          relPath: "Artist/Album/track.mp3",
          title: "T",
          artist: "A",
          album: "B",
        },
      ],
      currentIndex: 0,
    };
    engine.enqueueQueuePatch(queue);
    expect(engine.queueStateRef.current).toEqual(queue);
    expect(engine.pendingPatchRef.current.queue).toEqual(queue);
    expect(setState).not.toHaveBeenCalled();
  });

  it("schedulePendingFlush uses queue delay for queue-only pending", async () => {
    vi.mocked(patchUserState).mockResolvedValue({
      ...baseState(),
      revision: 3,
    });
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.dirtyRef.current = true;
    engine.pendingPatchRef.current = {
      queue: { tracks: [], currentIndex: 0 },
    };
    engine.schedulePendingFlush();
    vi.advanceTimersByTime(FLUSH_DELAY_QUEUE_MS - 1);
    expect(patchUserState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => {
      expect(patchUserState).toHaveBeenCalled();
    });
  });

  it("schedulePendingFlush uses default delay when patch is not queue-only", async () => {
    vi.mocked(patchUserState).mockResolvedValue({
      ...baseState(),
      revision: 3,
    });
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.dirtyRef.current = true;
    engine.pendingPatchRef.current = { favorites: ["x.mp3"] };
    engine.schedulePendingFlush();
    vi.advanceTimersByTime(FLUSH_DELAY_DEFAULT_MS - 1);
    expect(patchUserState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => {
      expect(patchUserState).toHaveBeenCalled();
    });
  });

  it("flushPendingPatch calls patchUserState and clears dirty on success", async () => {
    vi.mocked(patchUserState).mockResolvedValue({
      ...baseState(),
      revision: 3,
      favorites: ["saved.mp3"],
    });
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.pendingPatchRef.current = { favorites: ["saved.mp3"] };
    engine.dirtyRef.current = true;
    engine.flushPendingPatch();
    await vi.waitFor(() => {
      expect(patchUserState).toHaveBeenCalledWith(
        { favorites: ["saved.mp3"] },
        { accountId: null },
      );
    });
    expect(engine.dirtyRef.current).toBe(false);
    expect(setError).toHaveBeenCalledWith(null);
  });

  it("flushPendingPatch re-queues patch on failure", async () => {
    vi.mocked(patchUserState).mockRejectedValue(new Error("save failed"));
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.pendingPatchRef.current = { favorites: ["lost.mp3"] };
    engine.flushPendingPatch();
    await vi.waitFor(() => {
      expect(engine.pendingPatchRef.current.favorites).toEqual(["lost.mp3"]);
    });
    expect(engine.dirtyRef.current).toBe(true);
    expect(setError).toHaveBeenCalledWith("save failed");
  });

  it("flushUserStateNow clears debounce timer before flushing", async () => {
    vi.mocked(patchUserState).mockResolvedValue({
      ...baseState(),
      revision: 3,
    });
    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.dirtyRef.current = true;
    engine.pendingPatchRef.current = { favorites: ["x.mp3"] };
    engine.schedulePendingFlush();
    engine.flushUserStateNow();
    await vi.waitFor(() => {
      expect(patchUserState).toHaveBeenCalledTimes(1);
    });
    vi.advanceTimersByTime(FLUSH_DELAY_DEFAULT_MS);
    expect(patchUserState).toHaveBeenCalledTimes(1);
  });

  it("retries once on revision conflict then surfaces error", async () => {
    class UserStateRevisionConflict extends Error {
      name = "UserStateRevisionConflict";
      currentState: UserStateV1;
      constructor(currentState: UserStateV1) {
        super("USER_STATE_REVISION_CONFLICT");
        this.currentState = currentState;
      }
    }
    vi.mocked(patchUserState)
      .mockRejectedValueOnce(
        new UserStateRevisionConflict({ ...baseState(), revision: 9 }),
      )
      .mockRejectedValueOnce(new Error("still failing"));

    const engine = createEngine();
    engine.hydratedRef.current = true;
    engine.pendingPatchRef.current = { favorites: ["race.mp3"] };
    engine.flushPendingPatch();
    await vi.waitFor(() => {
      expect(patchUserState).toHaveBeenCalledTimes(2);
    });
    expect(setError).toHaveBeenCalledWith("still failing");
  });
});
