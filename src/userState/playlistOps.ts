import type { Dispatch, SetStateAction } from "react";
import { fmtDate } from "../lib/metaFormat";
import { randomUUID } from "../lib/randomUUID";
import type { EnrichedTrack, UserStatePatch, UserStateV1 } from "../types";

type CommitFn = (
  updater: (prev: UserStateV1) => UserStateV1,
  options?: {
    immediate?: boolean;
    silent?: boolean;
    patch?: (next: UserStateV1, prev: UserStateV1) => UserStatePatch;
  },
) => void;

type PlaylistOpsDeps = {
  commit: CommitFn;
  setSelectedPlaylist: Dispatch<SetStateAction<string | null>>;
};

export function createPlaylistOps({ commit, setSelectedPlaylist }: PlaylistOpsDeps) {
  const createPlaylist = (name: string) => {
    const id = randomUUID();
    commit(
      (prev) => ({
        ...prev,
        playlists: [
          ...prev.playlists,
          {
            id,
            name: name.trim() || "New playlist",
            tracks: [],
          },
        ],
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
    setSelectedPlaylist(id);
    return id;
  };

  const renamePlaylist = (id: string, name: string) => {
    commit(
      (prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === id
            ? { ...playlist, name: name.trim() || playlist.name }
            : playlist,
        ),
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
  };

  const deletePlaylist = (id: string) => {
    commit(
      (prev) => ({
        ...prev,
        playlists: prev.playlists.filter((playlist) => playlist.id !== id),
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
    setSelectedPlaylist((current) => (current === id ? null : current));
  };

  const addTrackToPlaylist = (id: string, track: EnrichedTrack) => {
    commit(
      (prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id !== id
            ? playlist
            : {
                ...playlist,
                tracks: playlist.tracks.some(
                  (item) => item.relPath === track.relPath,
                )
                  ? playlist.tracks
                  : [
                      ...playlist.tracks,
                      {
                        relPath: track.relPath,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                      },
                    ],
              },
        ),
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
  };

  const removeTrackFromPlaylist = (id: string, relPath: string) => {
    commit(
      (prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === id
            ? {
                ...playlist,
                tracks: playlist.tracks.filter(
                  (track) => track.relPath !== relPath,
                ),
              }
            : playlist,
        ),
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
  };

  const saveQueueAsPlaylist = (name: string, queue: EnrichedTrack[]) => {
    const id = randomUUID();
    commit(
      (prev) => ({
        ...prev,
        playlists: [
          ...prev.playlists,
          {
            id,
            name: name.trim() || `Queue ${fmtDate(new Date())}`,
            tracks: queue.map((track) => ({
              relPath: track.relPath,
              title: track.title,
              artist: track.artist,
              album: track.album,
            })),
          },
        ],
      }),
      { immediate: true, patch: (next) => ({ playlists: next.playlists }) },
    );
    setSelectedPlaylist(id);
    return id;
  };

  return {
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    saveQueueAsPlaylist,
  };
}
