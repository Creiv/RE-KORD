import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  fetchUserState,
  isBackendUnreachableError,
  patchUserState,
} from "../lib/api";
import {
  compactUserStatePatch,
  flushDelayMsForPending,
  mergeSavedUserState,
  mergeUserStatePatches,
} from "../lib/userStatePatch";
import type { QueueState, UserStatePatch, UserStateV1 } from "../types";

export type UserStateSyncEngineDeps = {
  setState: Dispatch<SetStateAction<UserStateV1>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  beginLibrarySyncActivity: (key: string) => () => void;
  normalizeUserState: (s: UserStateV1) => UserStateV1;
  mergeLegacy: (remote: UserStateV1) => UserStateV1;
  applyUserStatePatchLocal: (
    base: UserStateV1,
    patch: UserStatePatch,
  ) => UserStateV1;
  userStateToPatch: (
    state: UserStateV1,
    omitPlaylists?: boolean,
  ) => UserStatePatch;
};

export type UserStateSyncEngineRefs = {
  dirtyRef: MutableRefObject<boolean>;
  playlistDirtyRef: MutableRefObject<boolean>;
  hydratedRef: MutableRefObject<boolean>;
  saveSeqRef: MutableRefObject<number>;
  queueStateRef: MutableRefObject<QueueState>;
  pendingPatchRef: MutableRefObject<UserStatePatch>;
  inFlightPatchRef: MutableRefObject<UserStatePatch>;
  flushTimerRef: MutableRefObject<number | null>;
  hydratedAccountIdRef: MutableRefObject<string | null>;
  flushingRef: MutableRefObject<boolean>;
};

export type UserStateSyncEngine = UserStateSyncEngineRefs & {
  flushPendingPatch: (opts?: { silent?: boolean }) => void;
  schedulePendingFlush: () => void;
  flushUserStateNow: (opts?: { silent?: boolean }) => void;
  commit: (
    updater: (prev: UserStateV1) => UserStateV1,
    options?: {
      immediate?: boolean;
      silent?: boolean;
      patch?: (next: UserStateV1, prev: UserStateV1) => UserStatePatch;
    },
  ) => void;
  enqueueQueuePatch: (queue: QueueState) => void;
  setQueueSnapshot: (queue: QueueState) => void;
  syncUserStateFromServer: () => Promise<void>;
};

function isRevisionConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "UserStateRevisionConflict" ||
    err.message === "USER_STATE_REVISION_CONFLICT"
  );
}

function normalizeQueueState(queue: QueueState): QueueState {
  return {
    tracks: queue.tracks,
    currentIndex: Math.min(
      Math.max(queue.currentIndex, 0),
      Math.max(queue.tracks.length - 1, 0),
    ),
  };
}

export function createUserStateSyncEngine(
  deps: UserStateSyncEngineDeps,
): UserStateSyncEngine {
  const {
    setState,
    setSaving,
    setError,
    beginLibrarySyncActivity,
    normalizeUserState,
    mergeLegacy,
    applyUserStatePatchLocal,
    userStateToPatch,
  } = deps;

  const dirtyRef = { current: false };
  const playlistDirtyRef = { current: false };
  const hydratedRef = { current: false };
  const saveSeqRef = { current: 0 };
  const queueStateRef = { current: { tracks: [], currentIndex: 0 } as QueueState };
  const pendingPatchRef = { current: {} as UserStatePatch };
  const inFlightPatchRef = { current: {} as UserStatePatch };
  const flushTimerRef = { current: null as number | null };
  const hydratedAccountIdRef = { current: null as string | null };
  const flushingRef = { current: false };

  const flushPendingPatchRef = {
    current: null as ((opts?: { silent?: boolean }) => void) | null,
  };
  const schedulePendingFlushRef = { current: null as (() => void) | null };

  const schedulePendingFlush = () => {
    if (!hydratedRef.current || !dirtyRef.current) return;
    if (flushTimerRef.current != null) {
      window.clearTimeout(flushTimerRef.current);
    }
    const delayMs = flushDelayMsForPending(pendingPatchRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingPatchRef.current?.();
    }, delayMs);
  };

  const flushPendingPatch = (opts?: { silent?: boolean }) => {
    if (!hydratedRef.current || flushingRef.current) {
      if (hydratedRef.current && dirtyRef.current) {
        schedulePendingFlushRef.current?.();
      }
      return;
    }
    const patch = compactUserStatePatch(pendingPatchRef.current);
    if (Object.keys(patch).length === 0) {
      dirtyRef.current = false;
      return;
    }
    pendingPatchRef.current = {};
    inFlightPatchRef.current = patch;
    flushingRef.current = true;
    const seq = ++saveSeqRef.current;
    const queueOnly =
      Object.keys(patch).length === 1 && patch.queue !== undefined;
    const silent = Boolean(opts?.silent) || queueOnly;
    const endSaveActivity = silent
      ? () => {}
      : beginLibrarySyncActivity("sync.activity.savingUserState");
    if (!silent) setSaving(true);

    const attemptPatch = (retryOnConflict: boolean) => {
      patchUserState(patch, { accountId: hydratedAccountIdRef.current })
        .then((saved) => {
          if (seq !== saveSeqRef.current) return;
          const normalized = normalizeUserState(saved);
          const hasNewerPending =
            Object.keys(pendingPatchRef.current).length > 0;
          if (!queueOnly) {
            setState((prev) =>
              hasNewerPending
                ? {
                    ...prev,
                    revision: normalized.revision,
                  }
                : mergeSavedUserState(
                    prev,
                    normalized,
                    patch,
                    normalizeUserState,
                  ),
            );
          }
          setError(null);
          dirtyRef.current = hasNewerPending;
          if (patch.playlists) playlistDirtyRef.current = false;
          inFlightPatchRef.current = {};
        })
        .catch((err: unknown) => {
          if (seq !== saveSeqRef.current) return;
          if (retryOnConflict && isRevisionConflictError(err)) {
            const conflictState =
              err instanceof Error &&
              "currentState" in err &&
              typeof (err as { currentState?: UserStateV1 }).currentState ===
                "object"
                ? (err as { currentState: UserStateV1 }).currentState
                : null;
            if (conflictState) {
              const normalized = normalizeUserState(conflictState);
              setState((prev) => ({
                ...prev,
                revision: Math.max(
                  Number(normalized.revision || 1),
                  Number(prev.revision || 1),
                ),
              }));
            }
            attemptPatch(false);
            return;
          }
          pendingPatchRef.current = mergeUserStatePatches(
            patch,
            pendingPatchRef.current,
          );
          inFlightPatchRef.current = {};
          dirtyRef.current = true;
          setError(
            isBackendUnreachableError(err)
              ? "errors.backendUnreachable"
              : err instanceof Error
                ? err.message
                : String(err),
          );
        })
        .finally(() => {
          endSaveActivity();
          if (seq === saveSeqRef.current && !silent) setSaving(false);
          flushingRef.current = false;
          if (Object.keys(pendingPatchRef.current).length > 0) {
            schedulePendingFlushRef.current?.();
          }
        });
    };

    attemptPatch(true);
  };

  flushPendingPatchRef.current = flushPendingPatch;
  schedulePendingFlushRef.current = schedulePendingFlush;

  const flushUserStateNow = (opts?: { silent?: boolean }) => {
    if (flushTimerRef.current != null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushPendingPatch(opts);
  };

  const commit: UserStateSyncEngine["commit"] = (updater, options) => {
    setState((prev) => {
      const next = updater(prev);
      if (next === prev) return prev;
      dirtyRef.current = true;
      if (next.playlists !== prev.playlists) playlistDirtyRef.current = true;
      const omitPlaylists = !playlistDirtyRef.current;
      const patch =
        options?.patch?.(next, prev) ?? userStateToPatch(next, omitPlaylists);
      if (Object.keys(patch).length > 0) {
        pendingPatchRef.current = mergeUserStatePatches(
          pendingPatchRef.current,
          patch,
        );
      }
      if (options?.immediate) {
        window.setTimeout(
          () => flushPendingPatchRef.current?.({ silent: options?.silent }),
          0,
        );
      } else {
        schedulePendingFlush();
      }
      return next;
    });
  };

  const enqueueQueuePatch = (queue: QueueState) => {
    const nextQueue = normalizeQueueState(queue);
    queueStateRef.current = nextQueue;
    pendingPatchRef.current = mergeUserStatePatches(pendingPatchRef.current, {
      queue: nextQueue,
    });
    dirtyRef.current = true;
    schedulePendingFlush();
  };

  const setQueueSnapshot = (queue: QueueState) => {
    enqueueQueuePatch(queue);
  };

  const syncUserStateFromServer = () => {
    const endActivity = beginLibrarySyncActivity(
      "sync.activity.loadingUserState",
    );
    return Promise.resolve()
      .then(() => fetchUserState())
      .then((remote) => {
        const mergedRemote = normalizeUserState(mergeLegacy(remote));
        const localUnsaved = mergeUserStatePatches(
          inFlightPatchRef.current,
          pendingPatchRef.current,
        );
        const hasLocalUnsaved = Object.keys(localUnsaved).length > 0;
        const preserved = hasLocalUnsaved
          ? applyUserStatePatchLocal(mergedRemote, localUnsaved)
          : mergedRemote;
        queueStateRef.current = preserved.queue;
        setState((prev) => {
          if (
            !hasLocalUnsaved &&
            Number(mergedRemote.revision || 1) < Number(prev.revision || 1)
          ) {
            return prev;
          }
          if (!hasLocalUnsaved) return mergedRemote;
          return {
            ...preserved,
            revision: Math.max(
              Number(mergedRemote.revision || 1),
              Number(prev.revision || 1),
            ),
          };
        });
        dirtyRef.current = hasLocalUnsaved;
        playlistDirtyRef.current =
          hasLocalUnsaved && Boolean(localUnsaved.playlists);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          isBackendUnreachableError(err)
            ? "errors.backendUnreachable"
            : String(err),
        );
      })
      .finally(() => {
        endActivity();
      });
  };

  return {
    dirtyRef,
    playlistDirtyRef,
    hydratedRef,
    saveSeqRef,
    queueStateRef,
    pendingPatchRef,
    inFlightPatchRef,
    flushTimerRef,
    hydratedAccountIdRef,
    flushingRef,
    flushPendingPatch,
    schedulePendingFlush,
    flushUserStateNow,
    commit,
    enqueueQueuePatch,
    setQueueSnapshot,
    syncUserStateFromServer,
  };
}
