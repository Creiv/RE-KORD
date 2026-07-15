/* eslint-disable react-refresh/only-export-components -- hook + provider */
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  deleteAudioRelPaths,
  fetchTrackLyrics,
  saveTrackInfoManual,
} from "../lib/api";
import {
  markAutoLrcCheckedAfterError,
  runAutoLrcQuickSaveForTrack,
  type AutoLrcResult,
} from "../lib/autoLrc";
import {
  resolveTrackLyricsDotStatus,
  type TrackLyricsEphemeralAutoStatus,
} from "../lib/trackLyricsDotStatus";
import { useI18n } from "../i18n/useI18n";
import {
  runWithLibrarySyncActivity,
  useLibrarySyncActivity,
} from "../context/LibrarySyncActivityContext";
import { usePlayer } from "../context/PlayerContext";
import { useUserStateActions } from "../context/UserStateContext";
import { useAppConfirm } from "../context/AppConfirmContext";
import { parseTrackGenres, serializeTrackGenres } from "../lib/genres";
import {
  MAX_TRACK_MOODS,
  parseTrackMoods,
  TRACK_MOOD_COLORS,
  TRACK_MOOD_IDS,
  type TrackMoodId,
} from "../lib/trackMoods";
import { TrackMoodGlyph } from "./TrackMoodGlyph";
import type { EnrichedTrack, LibraryEntityDelta, TrackMeta } from "../types";
import { UiAdd, UiClose } from "./RekordUiIcons";

export type TrackMetaEditOpenOpts = {
  /** Apre subito l'editor lyrics dentro il dialog. */
  openLyrics?: boolean;
};

const TrackMetaEditContext = createContext<
  (track: EnrichedTrack, opts?: TrackMetaEditOpenOpts) => void
>(() => {});

type AutoLrcRunContextValue = {
  relPath: string | null;
  busy: boolean;
  status: TrackLyricsEphemeralAutoStatus;
  msg: string | null;
  runForTrack: (
    track: EnrichedTrack,
    onSaved?: (delta?: LibraryEntityDelta) => void | Promise<void>,
  ) => Promise<AutoLrcResult | null>;
};

const AutoLrcRunContext = createContext<AutoLrcRunContextValue>({
  relPath: null,
  busy: false,
  status: "idle",
  msg: null,
  runForTrack: async () => null,
});

export function useOpenTrackMetaEdit() {
  return useContext(TrackMetaEditContext);
}

export function useAutoLrcRun() {
  return useContext(AutoLrcRunContext);
}

function mergeTrackFromDelta(
  track: EnrichedTrack,
  delta: LibraryEntityDelta,
): EnrichedTrack {
  const patch = delta.track;
  if (!patch || patch.relPath !== track.relPath) return track;
  return {
    ...track,
    ...patch,
    title: patch.title ?? track.title,
    meta: {
      ...track.meta,
      ...(patch.meta ?? {}),
    } as TrackMeta,
  };
}

function toDateInputValue(raw: string | null | undefined): string {
  if (!raw?.trim()) return "";
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

export function TrackMetaEditGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
      />
    </svg>
  );
}

/**
 * Chiave di confronto generi: case-insensitive e indifferente ai separatori
 * ("Hip-Hop" ≡ "hip hop" ≡ "HIP_HOP"), così non nascono duplicati-varianti.
 */
function genreMatchKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function addGenreToken(current: string[], token: string): string[] {
  const t = token.trim();
  if (!t) return current;
  const k = genreMatchKey(t);
  if (current.some((g) => genreMatchKey(g) === k)) return current;
  return [...current, t];
}

function TrackMetaGenreSearch({
  genreOptions,
  genres,
  onAdd,
  t,
}: {
  genreOptions: readonly string[];
  genres: string[];
  onAdd: (genre: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const available = useMemo(
    () =>
      genreOptions.filter(
        (g) => !genres.some((s) => genreMatchKey(s) === genreMatchKey(g)),
      ),
    [genreOptions, genres],
  );

  const filtered = useMemo(() => {
    const q = genreMatchKey(query);
    if (!q) return available;
    return available.filter((g) => genreMatchKey(g).includes(q));
  }, [available, query]);

  const trimmedQuery = query.trim();
  const canAdd =
    trimmedQuery.length > 0 &&
    !genres.some((s) => genreMatchKey(s) === genreMatchKey(trimmedQuery));

  const commitQuery = useCallback(() => {
    if (!canAdd) return;
    // Se esiste già un genere equivalente in lista (es. "Rap" per "rap",
    // "Hip-Hop" per "hip hop"), seleziona quello invece di crearne una variante.
    const queryKey = genreMatchKey(trimmedQuery);
    const existing = genreOptions.find((g) => genreMatchKey(g) === queryKey);
    onAdd(existing ?? trimmedQuery);
    setQuery("");
    setOpen(true);
  }, [canAdd, genreOptions, onAdd, trimmedQuery]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [open]);

  const showList =
    open &&
    (filtered.length > 0 ||
      (trimmedQuery.length > 0 && canAdd) ||
      (available.length === 0 && !trimmedQuery));

  return (
    <div className="meta-edit-genre-search" ref={rootRef}>
      <div className="meta-edit-genre-search__row">
        <input
          id={inputId}
          className="ghost-input meta-edit-genre-search__input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitQuery();
            }
          }}
          placeholder={t("trackMeta.fieldGenreSearchPlaceholder")}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        <button
          type="button"
          className="meta-edit-genre-search__add"
          onClick={commitQuery}
          disabled={!canAdd}
          aria-label={t("trackMeta.fieldGenreAdd")}
          title={t("trackMeta.fieldGenreAdd")}
        >
          <UiAdd className="meta-edit-genre-search__add-ic" aria-hidden />
        </button>
      </div>
      {showList ? (
        filtered.length > 0 ? (
          <ul
            id={listId}
            className="meta-edit-genre-search__list"
            role="listbox"
            aria-label={t("trackMeta.fieldGenrePick")}
          >
            {filtered.map((g) => (
              <li key={g} role="presentation">
                <button
                  type="button"
                  role="option"
                  className="meta-edit-genre-search__option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onAdd(g);
                    setQuery("");
                    setOpen(true);
                  }}
                >
                  {g}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle sm meta-edit-genre-search__empty" id={listId}>
            {trimmedQuery
              ? t("trackMeta.fieldGenreNoMatch")
              : t("trackMeta.fieldGenreListEmpty")}
          </p>
        )
      ) : null}
    </div>
  );
}

function trackMoodsSignature(ids: TrackMoodId[]): string {
  return [...ids].slice().sort().join("\u0001");
}

function TrackMetaEditorModal({
  track,
  genreOptions,
  initialLyricsOpen = false,
  onClose,
  onSaved,
}: {
  track: EnrichedTrack | null;
  genreOptions: readonly string[];
  initialLyricsOpen?: boolean;
  onClose: () => void;
  onSaved: (delta?: LibraryEntityDelta) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { confirm: appConfirm } = useAppConfirm();
  const librarySync = useLibrarySyncActivity();
  const [title, setTitle] = useState("");
  const [releaseDate, setReleaseDate] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [moods, setMoods] = useState<TrackMoodId[]>([]);
  const [genreSearchReset, setGenreSearchReset] = useState(0);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsValue, setLyricsValue] = useState("");
  const [lyricsFetchBusy, setLyricsFetchBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lyricsErr, setLyricsErr] = useState<string | null>(null);
  const initialMoodsSigRef = useRef("");
  const initialLyricsRef = useRef("");
  const p = usePlayer();
  const { stripUserStateForRelPaths } = useUserStateActions();
  const autoLrc = useAutoLrcRun();

  useEffect(() => {
    if (!track) return;
    const timer = window.setTimeout(() => {
      const m = track.meta;
      const im = parseTrackMoods(m ?? undefined);
      setTitle(track.title);
      setReleaseDate(toDateInputValue(m?.releaseDate ?? null));
      setGenres(parseTrackGenres(m?.genre));
      setMoods(im);
      const lyr = String(m?.lyrics || "");
      setLyricsValue(lyr);
      setLyricsOpen(initialLyricsOpen);
      initialMoodsSigRef.current = trackMoodsSignature(im);
      initialLyricsRef.current = lyr;
      setGenreSearchReset((n) => n + 1);
      setErr(null);
      setLyricsErr(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [track, initialLyricsOpen]);

  const removeGenre = useCallback((i: number) => {
    setGenres((prev) => prev.filter((_, j) => j !== i));
  }, []);

  const addGenre = useCallback((genre: string) => {
    setGenres((prev) => addGenreToken(prev, genre));
  }, []);

  const toggleMood = useCallback((id: TrackMoodId) => {
    setMoods((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TRACK_MOODS) return prev;
      return [...prev, id];
    });
  }, []);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!track) return;
      setBusy(true);
      setErr(null);
      try {
        await runWithLibrarySyncActivity(
          librarySync.beginActivity,
          "sync.activity.savingTrackMeta",
          async () => {
            const patch = {
              title: title.trim() === "" ? null : title.trim(),
              releaseDate:
                releaseDate.trim() === "" ? null : releaseDate.trim(),
              genre: serializeTrackGenres(genres),
              ...(trackMoodsSignature(moods) !== initialMoodsSigRef.current
                ? { moods: moods.length ? moods : [] }
                : {}),
            };
            const saved = await saveTrackInfoManual(track.relPath, patch);
            await Promise.resolve(
              onSaved({
                relPath: saved.relPath,
                track:
                  saved.track ??
                  ({
                    relPath: saved.relPath,
                    title:
                      typeof patch.title === "string" && patch.title.trim()
                        ? patch.title.trim()
                        : track.title,
                    meta: saved.meta as EnrichedTrack["meta"],
                  } satisfies LibraryEntityDelta["track"]),
                album: saved.album,
              })
            );
          }
        );
        onClose();
      } catch (er: unknown) {
        setErr(er instanceof Error ? er.message : String(er));
      } finally {
        setBusy(false);
      }
    },
    [track, title, releaseDate, genres, moods, onClose, onSaved, librarySync]
  );

  const runDelete = useCallback(async () => {
    if (!track) return;
    if (
      !(await appConfirm({
        message: t("trackMeta.deleteConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    setDeleteBusy(true);
    setErr(null);
    try {
      await runWithLibrarySyncActivity(
        librarySync.beginActivity,
        "sync.activity.deletingTrack",
        async () => {
          const { deleted, affectedAlbums } = await deleteAudioRelPaths([
            track.relPath,
          ]);
          if (!deleted.length) {
            setErr(t("trackMeta.deleteFailed"));
            return;
          }
          for (const rel of deleted) p.removeFromQueueByRelPath(rel);
          stripUserStateForRelPaths(deleted);
          await Promise.resolve(onSaved({ deleted, affectedAlbums }));
          onClose();
        }
      );
    } catch (er: unknown) {
      setErr(er instanceof Error ? er.message : String(er));
    } finally {
      setDeleteBusy(false);
    }
  }, [onClose, onSaved, p, stripUserStateForRelPaths, t, track, appConfirm, librarySync]);

  const saveLyrics = useCallback(async () => {
    if (!track) return;
    setBusy(true);
    setLyricsErr(null);
    try {
      await runWithLibrarySyncActivity(
        librarySync.beginActivity,
        "sync.activity.savingLyrics",
        async () => {
          const patch = {
            lyrics: lyricsValue.trim() ? lyricsValue : null,
          };
          const saved = await saveTrackInfoManual(track.relPath, patch);
          await Promise.resolve(
            onSaved({
              relPath: saved.relPath,
              track:
                saved.track ??
                ({
                  relPath: saved.relPath,
                  title: track.title,
                  meta: {
                    ...(track.meta || {}),
                    ...(saved.meta as EnrichedTrack["meta"]),
                    lyrics: patch.lyrics,
                  } as EnrichedTrack["meta"],
                } satisfies LibraryEntityDelta["track"]),
              album: saved.album,
            })
          );
        }
      );
      setLyricsOpen(false);
    } catch (er: unknown) {
      setLyricsErr(er instanceof Error ? er.message : String(er));
    } finally {
      setBusy(false);
    }
  }, [lyricsValue, librarySync, onSaved, track]);

  const cancelLyrics = useCallback(() => {
    setLyricsValue(initialLyricsRef.current);
    setLyricsOpen(false);
  }, []);

  const fetchLyricsLrc = useCallback(async () => {
    if (!track) return;
    setLyricsFetchBusy(true);
    setLyricsErr(null);
    try {
      await runWithLibrarySyncActivity(
        librarySync.beginActivity,
        "sync.activity.fetchingLyrics",
        async () => {
          const fetched = await fetchTrackLyrics(track.relPath);
          const synced = String(fetched.syncedLyrics || "").trim();
          const plain = String(fetched.plainLyrics || "").trim();
          const next = synced || plain;
          if (!next) {
            setLyricsErr(t("trackMeta.fetchLrcEmpty"));
            return;
          }
          if (!synced && plain) {
            setLyricsErr(t("trackMeta.fetchLrcPlainFound"));
          }
          setLyricsValue(next);
        }
      );
    } catch (er: unknown) {
      setLyricsErr(er instanceof Error ? er.message : String(er));
    } finally {
      setLyricsFetchBusy(false);
    }
  }, [librarySync, t, track]);

  const runAutoLrcQuickSave = useCallback(async () => {
    if (!track) return;
    setLyricsErr(null);
    try {
      await runWithLibrarySyncActivity(
        librarySync.beginActivity,
        "sync.activity.savingLyrics",
        async () => {
          const result = await autoLrc.runForTrack(track, onSaved);
          if (!result) return;
          if (result.status === "missing") {
            setLyricsErr(t("trackMeta.fetchLrcEmpty"));
            return;
          }
          setLyricsValue(result.lyrics ?? "");
          if (result.status === "okPlain") {
            setLyricsErr(t("trackMeta.fetchLrcPlainFound"));
          }
        },
      );
    } catch (er: unknown) {
      setLyricsErr(er instanceof Error ? er.message : String(er));
    }
  }, [autoLrc, librarySync, onSaved, t, track]);

  if (!track) return null;
  const autoLrcBusyForTrack =
    autoLrc.busy && autoLrc.relPath === track.relPath;
  const lyricsDotStatus = resolveTrackLyricsDotStatus({
    meta: track.meta,
    lyricsText: lyricsValue,
    fetchBusy: autoLrcBusyForTrack || lyricsFetchBusy,
    ephemeralAutoStatus:
      autoLrc.relPath === track.relPath ? autoLrc.status : "idle",
  });

  const lyricsPortal = lyricsOpen
    ? createPortal(
        <div
          className="meta-edit-backdrop meta-edit-backdrop--lyrics-portal"
          role="presentation"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setLyricsOpen(false);
          }}
        >
          <div
            className="meta-edit-dialog surface-card meta-edit-lyrics-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("trackMeta.editLyrics")}
          >
            <textarea
              className="log meta-edit-lyrics-textarea"
              rows={14}
              value={lyricsValue}
              onChange={(ev) => setLyricsValue(ev.target.value)}
              placeholder={t("trackMeta.lyricsPlaceholder")}
            />
            {lyricsErr ? (
              <p className="subtle sm warnline mt-1">{lyricsErr}</p>
            ) : null}
            <div className="meta-edit-actions">
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || deleteBusy || lyricsFetchBusy}
                onClick={cancelLyrics}
              >
                {t("trackMeta.editCancel")}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || deleteBusy || lyricsFetchBusy}
                onClick={() => {
                  void fetchLyricsLrc();
                }}
              >
                {lyricsFetchBusy
                  ? t("trackMeta.fetchLrcBusy")
                  : t("trackMeta.fetchLrc")}
              </button>
              <span className="meta-edit-actions__spacer" aria-hidden />
              <button
                type="button"
                className="primary-btn"
                disabled={busy || deleteBusy || lyricsFetchBusy}
                onClick={() => {
                  void saveLyrics();
                }}
              >
                {busy ? t("trackMeta.editSaving") : t("trackMeta.saveLyrics")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <Fragment>
      <div
        className="meta-edit-backdrop"
        role="presentation"
        onClick={(ev) => {
          if (lyricsOpen) return;
          if (ev.target === ev.currentTarget) onClose();
        }}
      >
        <div
          className="meta-edit-dialog surface-card"
          role="dialog"
          aria-labelledby="meta-edit-title"
          aria-modal="true"
        >
          <div className="section-head">
            <div>
              <p className="eyebrow">{t("trackMeta.editEyebrow")}</p>
              <h2 id="meta-edit-title">{t("trackMeta.editHeading")}</h2>
              <p className="subtle sm meta-edit-path">{track.relPath}</p>
            </div>
            <button type="button" className="text-btn" onClick={onClose}>
              {t("trackMeta.editClose")}
            </button>
          </div>
          <form className="meta-edit-form" onSubmit={submit}>
            <label className="meta-edit-field">
              <span>{t("trackMeta.fieldTitle")}</span>
              <input
                className="ghost-input w-full"
                value={title}
                onChange={(ev) => setTitle(ev.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="meta-edit-field">
              <span>{t("trackMeta.fieldReleaseDate")}</span>
              <input
                className="ghost-input w-full"
                type="date"
                value={releaseDate}
                onChange={(ev) => setReleaseDate(ev.target.value)}
              />
            </label>
            <div className="meta-edit-field">
              <span>{t("trackMeta.fieldGenre")}</span>
              <div className="meta-edit-genre-chips" role="list">
                {genres.map((g, i) => (
                  <span
                    key={`${g}-${i}`}
                    className="meta-edit-genre-chip"
                    role="listitem"
                  >
                    <span className="meta-edit-genre-chip__text">{g}</span>
                    <button
                      type="button"
                      className="meta-edit-genre-chip__x"
                      onClick={() => removeGenre(i)}
                      aria-label={t("trackMeta.fieldGenreRemoveAria", { g })}
                    >
                      <UiClose className="meta-edit-genre-chip__x-ic" />
                    </button>
                  </span>
                ))}
              </div>
              <TrackMetaGenreSearch
                key={genreSearchReset}
                genreOptions={genreOptions}
                genres={genres}
                onAdd={addGenre}
                t={t}
              />
            </div>
            <div className="meta-edit-field">
              <span>{t("trackMeta.fieldMood")}</span>
              <div
                className="meta-edit-mood-grid"
                role="group"
                aria-label={t("trackMeta.fieldMood")}
              >
                {TRACK_MOOD_IDS.map((id) => {
                  const on = moods.includes(id);
                  const c = TRACK_MOOD_COLORS[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`meta-edit-mood-btn meta-edit-mood-btn--color${
                        on ? " meta-edit-mood-btn--on" : ""
                      }`}
                      style={{ "--mood-c": c } as CSSProperties}
                      aria-pressed={on}
                      title={t(`trackMeta.mood.${id}`)}
                      onClick={() => toggleMood(id)}
                    >
                      <TrackMoodGlyph mood={id} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="meta-edit-field meta-edit-lyrics-row">
              <span>{t("trackMeta.fieldLyrics")}</span>
              <div className="meta-edit-lyrics-actions">
                <button
                  type="button"
                  className="ghost-btn meta-edit-lyrics-btn"
                  disabled={busy || deleteBusy || lyricsFetchBusy}
                  onClick={() => setLyricsOpen(true)}
                >
                  {t("trackMeta.lyricsEditBtn")}
                </button>
                <button
                  type="button"
                  className="ghost-btn meta-edit-lyrics-btn"
                  disabled={busy || deleteBusy || autoLrcBusyForTrack || lyricsFetchBusy}
                  onClick={() => {
                    void runAutoLrcQuickSave();
                  }}
                >
                  {autoLrcBusyForTrack ? t("trackMeta.fetchLrcBusy") : t("trackMeta.fetchLrc")}
                </button>
                <span
                  className={`meta-edit-lyrics-status-dot meta-edit-lyrics-status-dot--${lyricsDotStatus}`}
                  title={t(`trackMeta.lyricsAutoStatus.${lyricsDotStatus}`)}
                  aria-label={t(`trackMeta.lyricsAutoStatus.${lyricsDotStatus}`)}
                />
              </div>
            </div>
            {err ? <p className="subtle sm warnline">{err}</p> : null}
            <div className="meta-edit-actions">
              <button
                type="button"
                className="ghost-btn danger"
                disabled={busy || deleteBusy}
                onClick={() => {
                  void runDelete();
                }}
              >
                {deleteBusy
                  ? t("trackMeta.deleting")
                  : t("trackMeta.deleteFile")}
              </button>
              <span className="meta-edit-actions__spacer" aria-hidden />
              <button type="button" className="ghost-btn" onClick={onClose}>
                {t("trackMeta.editCancel")}
              </button>
              <button
                type="submit"
                className="primary-btn"
                disabled={busy || deleteBusy}
              >
                {busy ? t("trackMeta.editSaving") : t("trackMeta.editSave")}
              </button>
            </div>
          </form>
        </div>
      </div>
      {lyricsPortal}
    </Fragment>
  );
}

export function TrackMetaEditProvider({
  children,
  genreOptions,
  onSaved,
}: {
  children: React.ReactNode;
  genreOptions: readonly string[];
  onSaved: (delta?: LibraryEntityDelta) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [openState, setOpenState] = useState<{
    track: EnrichedTrack;
    openLyrics: boolean;
  } | null>(null);
  const [autoLrcRelPath, setAutoLrcRelPath] = useState<string | null>(null);
  const [autoLrcBusy, setAutoLrcBusy] = useState(false);
  const [autoLrcStatus, setAutoLrcStatus] =
    useState<TrackLyricsEphemeralAutoStatus>("idle");
  const [autoLrcMsg, setAutoLrcMsg] = useState<string | null>(null);

  const applySaved = useCallback(
    async (delta?: LibraryEntityDelta) => {
      await Promise.resolve(onSaved(delta));
      if (!delta?.track?.relPath) return;
      setOpenState((prev) => {
        if (!prev || prev.track.relPath !== delta.track?.relPath) return prev;
        return { ...prev, track: mergeTrackFromDelta(prev.track, delta) };
      });
    },
    [onSaved],
  );

  const runForTrack = useCallback(
    async (
      track: EnrichedTrack,
      onSavedOverride?: (delta?: LibraryEntityDelta) => void | Promise<void>,
    ) => {
      if (autoLrcBusy) return null;
      const save = onSavedOverride ?? applySaved;
      setAutoLrcRelPath(track.relPath);
      setAutoLrcBusy(true);
      setAutoLrcStatus("idle");
      setAutoLrcMsg(null);
      try {
        const result = await runAutoLrcQuickSaveForTrack(track);
        await Promise.resolve(save(result.delta));
        setAutoLrcStatus(result.status);
        if (result.status === "missing") {
          setAutoLrcMsg(t("trackMeta.fetchLrcEmpty"));
        } else if (result.status === "okPlain") {
          setAutoLrcMsg(t("trackMeta.fetchLrcPlainFound"));
        }
        return result;
      } catch (er: unknown) {
        setAutoLrcStatus("error");
        setAutoLrcMsg(er instanceof Error ? er.message : String(er));
        const delta = await markAutoLrcCheckedAfterError(track);
        if (delta) await Promise.resolve(save(delta));
        return null;
      } finally {
        setAutoLrcBusy(false);
      }
    },
    [applySaved, autoLrcBusy, t],
  );

  const open = useCallback(
    (tr: EnrichedTrack, opts?: TrackMetaEditOpenOpts) =>
      setOpenState({ track: tr, openLyrics: opts?.openLyrics === true }),
    [],
  );

  const autoLrcValue = useMemo(
    () => ({
      relPath: autoLrcRelPath,
      busy: autoLrcBusy,
      status: autoLrcStatus,
      msg: autoLrcMsg,
      runForTrack,
    }),
    [autoLrcBusy, autoLrcMsg, autoLrcRelPath, autoLrcStatus, runForTrack],
  );

  return (
    <TrackMetaEditContext.Provider value={open}>
      <AutoLrcRunContext.Provider value={autoLrcValue}>
        {children}
        <TrackMetaEditorModal
          track={openState?.track ?? null}
          genreOptions={genreOptions}
          initialLyricsOpen={openState?.openLyrics ?? false}
          onClose={() => setOpenState(null)}
          onSaved={applySaved}
        />
      </AutoLrcRunContext.Provider>
    </TrackMetaEditContext.Provider>
  );
}
