import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { useAppConfirm } from "../../../context/AppConfirmContext";
import {
  createMusicSubdir,
  fetchDownloadFlatCount,
  fetchDownloadPreset,
  listMusicDirs,
  newStudioDownloadId,
  runYtdlpDownload,
  cancelStudioDownload,
  searchMusicDirs,
  streamYoutubeReleasesList,
  waitForLibraryEpoch,
} from "../../../lib/api";
import type {
  FsDirSearchResult,
  StudioDownloadKind,
  YoutubeExploreResult,
  YoutubeReleasesList,
} from "../../../lib/api";
import {
  buildDownloadSummaryLine,
  buildReleaseBatchSummaryLine,
} from "../../../lib/downloadLogSummary";
import { ytdlpLogDetailForUser } from "../../../lib/ytdlpLogFilter";
import { partitionYoutubeReleaseEntries } from "../../../lib/youtubeReleases";
import {
  isValidDownloadDestPath,
  normalizeDownloadDestPath,
  relPathLooksLikeAlbumFolderDest,
  resolveStudioDownloadOutputDir,
  studioDownloadKindForScope,
  type StudioDownloadScope,
} from "../../../lib/studioDownloadDest";
import {
  studioDownloadSourceForArtistUrl,
  urlMatchesStudioDlMode,
  type DlVideoMode,
} from "../../../lib/youtubeUrl";
import {
  REKORD_DL_OK,
  REKORD_DL_OUT,
  LEGACY_DL_OK,
  LEGACY_DL_OUT,
  REKORD_DL_STUDIO_MODE,
  migrateSessionKey,
  migrateSessionFlag,
  clearLegacySessionKeys,
  readStoredDlStudioMode,
  exploreScopeForItem,
  exploreDownloadPreamble,
  buildReleasesArtistFolderConfirm,
  prepareStudioDownload,
  normalizeDlProgress,
  normalizeTrackInAlbumProgress,
  type DlStudioMode,
} from "../../../components/toolsViewShared";
import type { StudioPanelBaseDeps } from "./studioPanelShared";

export type StudioDownloadPanelDeps = StudioPanelBaseDeps & {
  appConfirm: ReturnType<typeof useAppConfirm>["confirm"];
};

export function useStudioDownloadPanel({
  libraryIndex,
  onReconcileLibrary,
  tools,
  t,
  appConfirm,
}: StudioDownloadPanelDeps) {
  const {
    log,
    setLog,
    dlBusy,
    setDlBusy,
    dlProg,
    setDlProg,
    dlTrackProg,
    setDlTrackProg,
    mkBusy,
    setMkBusy,
  } = tools;

  const downloadSummaryLine = useCallback(
    (r: Parameters<typeof buildDownloadSummaryLine>[0]) =>
      buildDownloadSummaryLine(r, t),
    [t],
  );

  const [url, setUrl] = useState("");
  const [dlStudioMode, setDlStudioMode] = useState<DlStudioMode>(
    readStoredDlStudioMode,
  );
  const [dlUrlMode, setDlUrlMode] = useState<DlVideoMode>("single");
  const [dlList, setDlList] = useState<{
    path: string;
    parent: string;
    dirs: { name: string; relPath: string }[];
    musicRoot: string;
  } | null>(null);
  const [dlDirQuery, setDlDirQuery] = useState("");
  const [dlDirResults, setDlDirResults] = useState<FsDirSearchResult[]>([]);
  const [dlDirSearchBusy, setDlDirSearchBusy] = useState(false);
  const [dlDirSearchOpen, setDlDirSearchOpen] = useState(false);
  const dlDirSearchInputRef = useRef<HTMLInputElement>(null);
  const [dlPath, setDlPath] = useState(() => {
    try {
      if (!migrateSessionFlag(REKORD_DL_OK, LEGACY_DL_OK)) return "";
      const saved = normalizeDownloadDestPath(
        migrateSessionKey(REKORD_DL_OUT, LEGACY_DL_OUT) ?? "",
      );
      return saved;
    } catch {
      return "";
    }
  });
  const [dlDestPicked, setDlDestPicked] = useState(() => {
    try {
      const saved = normalizeDownloadDestPath(
        migrateSessionKey(REKORD_DL_OUT, LEGACY_DL_OUT) ?? "",
      );
      return (
        Boolean(saved) &&
        migrateSessionFlag(REKORD_DL_OK, LEGACY_DL_OK)
      );
    } catch {
      return false;
    }
  });
  const [newDirName, setNewDirName] = useState("");
  const [relPayload, setRelPayload] = useState<YoutubeReleasesList | null>(
    null,
  );
  const [relStreamComplete, setRelStreamComplete] = useState(false);
  const [relEnrichBusy, setRelEnrichBusy] = useState(false);
  const [relSel, setRelSel] = useState<Set<string>>(() => new Set());
  const [relQuery, setRelQuery] = useState("");
  const [relLoadBusy, setRelLoadBusy] = useState(false);
  const relAborter = useRef<AbortController | null>(null);
  const relLogTotalRef = useRef(0);
  const relEntryBatchRef = useRef<
    NonNullable<typeof relPayload>["entries"][number][]
  >([]);
  const relEntryFlushRafRef = useRef<number | null>(null);
  const relLogUploaderRef = useRef("");
  const dlActiveDownloadIdRef = useRef<string | null>(null);
  const dlBatchStopRef = useRef(false);
  const studioDlRunLatchRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(REKORD_DL_STUDIO_MODE, dlStudioMode);
    } catch {
      /* ignore */
    }
  }, [dlStudioMode]);

  const loadPreset = useCallback(() => {
    fetchDownloadPreset()
      .then((d) => {
        if (d.exampleUrl) setUrl(d.exampleUrl);
      })
      .catch((e) => setLog((x) => x + t("tools.logCmdErr", { e })));
  }, [t, setLog]);

  useEffect(() => {
    loadPreset();
  }, [loadPreset]);

  const commitDlDest = useCallback((path: string) => {
    const normalized = normalizeDownloadDestPath(path);
    setDlPath(normalized);
    setDlDestPicked(Boolean(normalized));
    try {
      if (normalized) {
        sessionStorage.setItem(REKORD_DL_OK, "1");
        sessionStorage.setItem(REKORD_DL_OUT, normalized);
      } else {
        sessionStorage.removeItem(REKORD_DL_OK);
        sessionStorage.removeItem(REKORD_DL_OUT);
        clearLegacySessionKeys();
      }
    } catch {
      /* ignore */
    }
  }, []);

  const clearDownloadDestination = useCallback(() => {
    setDlPath("");
    setDlDestPicked(false);
    try {
      sessionStorage.removeItem(REKORD_DL_OK);
      sessionStorage.removeItem(REKORD_DL_OUT);
      clearLegacySessionKeys();
    } catch {
      /* ignore */
    }
  }, []);

  const loadDlFs = useCallback(
    (path: string) => {
      listMusicDirs(path)
        .then((data) => {
          setDlList(data);
          const browsed = data.path ?? "";
          if (isValidDownloadDestPath(browsed)) {
            commitDlDest(browsed);
          }
        })
        .catch((e) => setLog((x) => x + t("tools.logFolderErr", { e })));
    },
    [t, commitDlDest, setLog],
  );

  useEffect(() => {
    setRelPayload(null);
    setRelStreamComplete(false);
    setRelSel(new Set());
    setRelQuery("");
  }, [url, dlUrlMode]);

  useEffect(() => {
    loadDlFs("");
  }, [loadDlFs]);

  useEffect(() => {
    const q = dlDirQuery.trim();
    if (!q) {
      setDlDirResults([]);
      setDlDirSearchBusy(false);
      return;
    }
    let cancelled = false;
    setDlDirSearchBusy(true);
    const timer = window.setTimeout(() => {
      searchMusicDirs(q)
        .then((results) => {
          if (!cancelled) setDlDirResults(results);
        })
        .catch((e) => {
          if (!cancelled) {
            setDlDirResults([]);
            setLog((x) => x + t("tools.logFolderErr", { e }));
          }
        })
        .finally(() => {
          if (!cancelled) setDlDirSearchBusy(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dlDirQuery, setLog, t]);

  useEffect(() => {
    if (dlDirQuery.trim()) setDlDirSearchOpen(true);
  }, [dlDirQuery]);

  const toggleDlDirSearch = () => {
    setDlDirSearchOpen((open) => {
      const next = !open;
      if (next) {
        window.requestAnimationFrame(() => dlDirSearchInputRef.current?.focus());
      }
      return next;
    });
  };

  useEffect(
    () => () => {
      relAborter.current?.abort();
    },
    [],
  );

  const dlUrlPlaceholder = useMemo(() => {
    if (dlUrlMode === "single") return t("tools.dlUrlPhSingle");
    if (dlUrlMode === "playlist") return t("tools.dlUrlPhPlaylist");
    return t("tools.dlUrlPhReleases");
  }, [dlUrlMode, t]);

  const showMultiAlbumPicker = dlUrlMode === "releases";

  const filteredRelEntries = useMemo(() => {
    const entries = relPayload?.entries ?? [];
    const q = relQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.url.toLowerCase().includes(q),
    );
  }, [relPayload?.entries, relQuery]);

  const { albums: filteredRelAlbums, songs: filteredRelSongs } = useMemo(
    () => partitionYoutubeReleaseEntries(filteredRelEntries),
    [filteredRelEntries],
  );

  const dlUrlValid = useMemo(
    () => urlMatchesStudioDlMode(url, "video", dlUrlMode),
    [url, dlUrlMode],
  );

  const doCreateFolder = () => {
    const n = newDirName.trim();
    if (n.length < 1 || !dlList) return;
    if (relPathLooksLikeAlbumFolderDest(dlList.path || "")) {
      setLog((x) => x + t("tools.dlMkdirBlockedInAlbum") + "\n");
      return;
    }
    setMkBusy(true);
    createMusicSubdir(dlList.path || "", n)
      .then(({ relPath }) => {
        setLog((x) => x + t("tools.logNewFolder", { path: relPath }));
        setNewDirName("");
        loadDlFs(relPath);
      })
      .catch((e) => setLog((x) => x + t("tools.logFolderErr", { e })))
      .finally(() => setMkBusy(false));
  };

  const stopStudioDownload = () => {
    dlBatchStopRef.current = true;
    const id = dlActiveDownloadIdRef.current;
    if (id) void cancelStudioDownload(id);
  };

  const hasValidDownloadDest =
    dlDestPicked && isValidDownloadDestPath(dlPath);

  const releasesDlBlockedAlbumFolder =
    showMultiAlbumPicker &&
    hasValidDownloadDest &&
    relPathLooksLikeAlbumFolderDest(dlPath);

  const exploreSingleBlockedArtistFolder =
    hasValidDownloadDest && !relPathLooksLikeAlbumFolderDest(dlPath);

  const prepareExploreDownload = useCallback(
    async (item: YoutubeExploreResult) => {
      const scope = exploreScopeForItem(item);
      if (scope === "single" && exploreSingleBlockedArtistFolder) {
        return false;
      }
      let trackCount: number | null = null;
      if (scope === "playlist") {
        try {
          trackCount = await fetchDownloadFlatCount(item.url);
        } catch (e) {
          setLog(
            (x) =>
              x +
              t("tools.dlPlaylistCountErr", {
                e: String((e as Error)?.message || e),
              }),
          );
          return false;
        }
      }
      return prepareStudioDownload({
        hasValidDownloadDest,
        dlPath,
        scope,
        releaseTitle: scope === "playlist" ? item.title : undefined,
        trackCount,
        preamble: exploreDownloadPreamble(item, t),
        t,
        appConfirm,
        onLog: setLog,
      });
    },
    [hasValidDownloadDest, dlPath, exploreSingleBlockedArtistFolder, appConfirm, t, setLog],
  );

  const runDl = () => {
    if (!url.trim()) return;
    if (!urlMatchesStudioDlMode(url, "video", dlUrlMode)) {
      setLog((x) => x + t("tools.dlUrlMismatch"));
      return;
    }
    if (showMultiAlbumPicker) {
      setLog((x) => x + t("tools.dlNeedLoadReleases"));
      return;
    }
    if (!hasValidDownloadDest) {
      setLog((x) => x + t("tools.dlPickFolder"));
      return;
    }
    if (studioDlRunLatchRef.current || dlBusy) return;
    studioDlRunLatchRef.current = true;
    void (async () => {
      try {
        const scope: StudioDownloadScope =
          dlUrlMode === "playlist" ? "playlist" : "single";
        let trackCount: number | null = null;
        if (scope === "playlist") {
          try {
            trackCount = await fetchDownloadFlatCount(url.trim());
          } catch (e) {
            setLog(
              (x) =>
                x +
                t("tools.dlPlaylistCountErr", {
                  e: String((e as Error)?.message || e),
                }),
            );
            return;
          }
        }
        if (
          !(await prepareStudioDownload({
            hasValidDownloadDest,
            dlPath,
            scope,
            trackCount,
            t,
            appConfirm,
            onLog: setLog,
          }))
        ) {
          return;
        }
        const outputDir = resolveStudioDownloadOutputDir(dlPath, scope);
        const studioDlKind = studioDownloadKindForScope(scope);
        setDlBusy(true);
        setDlProg(null);
        setDlTrackProg(null);
        dlBatchStopRef.current = false;
        try {
          const dlId = newStudioDownloadId();
          dlActiveDownloadIdRef.current = dlId;
          setLog(
            (x) =>
              x +
              t("tools.dlStart", {
                path: dlPath,
              }),
          );
          const r = await runYtdlpDownload(
            url.trim(),
            outputDir,
            (p) => setDlProg({ current: p.current, total: p.total }),
            { downloadId: dlId, downloadKind: studioDlKind },
          );
          if (r.progress && r.progress.total > 0) {
            setDlProg({ current: r.progress.current, total: r.progress.total });
          }
          if (r.cancelled) setDlProg(null);
          const detail = ytdlpLogDetailForUser(r);
          setLog((x) => {
            if (r.cancelled) return x + t("tools.dlStoppedByUser") + "\n";
            return (
              x +
              (r.ok
                ? t("tools.dlResultOk")
                : t("tools.dlResultErr", { code: r.code }) +
                  (detail ? t("tools.dlErrDetail", { detail }) : "")) +
              downloadSummaryLine(r)
            );
          });
          if (r.ok) {
            const epochBefore = libraryIndex?.indexEpoch ?? 0;
            if (!(typeof r.indexEpoch === "number" && r.indexEpoch > epochBefore)) {
              await waitForLibraryEpoch(epochBefore, { timeoutMs: 45_000 });
            }
          }
          await onReconcileLibrary({ mode: "now" });
        } catch (e) {
          setLog(
            (x) =>
              x + t("tools.dlFail", { e: String((e as Error)?.message || e) }),
          );
        } finally {
          dlActiveDownloadIdRef.current = null;
        }
      } finally {
        setDlBusy(false);
        studioDlRunLatchRef.current = false;
      }
    })();
  };

  const loadReleasesCatalog = () => {
    if (!url.trim()) return;
    if (!urlMatchesStudioDlMode(url, "video", dlUrlMode)) {
      setLog((x) => x + t("tools.dlUrlMismatch"));
      return;
    }
    if (!hasValidDownloadDest) {
      setLog((x) => x + t("tools.dlPickFolder"));
      return;
    }
    relAborter.current?.abort();
    relAborter.current = new AbortController();
    const signal = relAborter.current.signal;
    relEntryBatchRef.current = [];
    if (relEntryFlushRafRef.current != null) {
      window.cancelAnimationFrame(relEntryFlushRafRef.current);
      relEntryFlushRafRef.current = null;
    }
    setRelLoadBusy(true);
    setRelStreamComplete(false);
    setRelEnrichBusy(false);
    setRelPayload(null);
    setRelSel(new Set());
    void streamYoutubeReleasesList(
      url.trim(),
      {
        onMeta: (m) => {
          relLogTotalRef.current = m.total;
          relLogUploaderRef.current = m.uploader;
          setRelPayload({
            listTitle: m.listTitle,
            uploader: m.uploader,
            channelUrl: m.channelUrl,
            entries: [],
          });
        },
        onEntry: (e) => {
          relEntryBatchRef.current.push(e);
          if (relEntryFlushRafRef.current != null) return;
          relEntryFlushRafRef.current = window.requestAnimationFrame(() => {
            relEntryFlushRafRef.current = null;
            const batch = relEntryBatchRef.current;
            relEntryBatchRef.current = [];
            if (!batch.length) return;
            setRelPayload((p) =>
              p ? { ...p, entries: [...p.entries, ...batch] } : null,
            );
          });
        },
        onListReady: () => {
          if (relEntryFlushRafRef.current != null) {
            window.cancelAnimationFrame(relEntryFlushRafRef.current);
            relEntryFlushRafRef.current = null;
          }
          const batch = relEntryBatchRef.current;
          relEntryBatchRef.current = [];
          if (batch.length) {
            setRelPayload((p) =>
              p ? { ...p, entries: [...p.entries, ...batch] } : null,
            );
          }
          setRelStreamComplete(true);
          setRelLoadBusy(false);
          setRelEnrichBusy(true);
          const n = relLogTotalRef.current;
          const u = relLogUploaderRef.current;
          setLog(
            (x) =>
              x +
              t("tools.dlReleasesListTitle") +
              `: ${n}` +
              (u ? ` — ${t("tools.dlReleasesUploader", { name: u })}` : "") +
              "\n",
          );
        },
        onEntryPatch: (e) => {
          setRelPayload((p) => {
            if (!p) return p;
            return {
              ...p,
              entries: p.entries.map((row) =>
                row.id === e.id
                  ? { ...row, trackCount: e.trackCount ?? row.trackCount }
                  : row,
              ),
            };
          });
        },
        onDone: () => {
          setRelLoadBusy(false);
          setRelEnrichBusy(false);
        },
      },
      { enrichCounts: true, signal },
    ).catch((e) => {
      if (String((e as Error)?.name) === "AbortError") {
        setRelLoadBusy(false);
        return;
      }
      setLog(
        (x) =>
          x + t("tools.pickerErr", { e: String((e as Error)?.message || e) }),
      );
      setRelLoadBusy(false);
      setRelPayload(null);
      setRelStreamComplete(false);
      setRelEnrichBusy(false);
    });
  };

  const runReleasesDl = () => {
    if (!urlMatchesStudioDlMode(url, "video", dlUrlMode)) {
      setLog((x) => x + t("tools.dlUrlMismatch"));
      return;
    }
    if (!relPayload || !hasValidDownloadDest) {
      if (!hasValidDownloadDest) setLog((x) => x + t("tools.dlPickFolder"));
      return;
    }
    if (!relStreamComplete) {
      setLog((x) => x + t("tools.dlReleasesWaitEnrich") + "\n");
      return;
    }
    const list = relPayload.entries.filter((e) => relSel.has(e.id));
    if (list.length === 0) {
      setLog((x) => x + t("tools.dlNeedSelection"));
      return;
    }
    if (studioDlRunLatchRef.current || dlBusy) return;
    studioDlRunLatchRef.current = true;
    void (async () => {
      try {
        const studioDlKind: StudioDownloadKind =
          studioDownloadSourceForArtistUrl(url) === "music"
            ? "download_ytmusic"
            : "download_releases";
        if (releasesDlBlockedAlbumFolder) {
          setLog((x) => x + t("tools.dlReleasesBlockedAlbumFolderLog") + "\n");
          return;
        }
        if (
          !(await appConfirm({
            variant: "warning",
            message: buildReleasesArtistFolderConfirm({
              dlPath,
              entries: list,
              libraryIndex,
              t,
            }),
          }))
        ) {
          return;
        }
        setDlBusy(true);
        dlBatchStopRef.current = false;
        setDlTrackProg({ current: 0, total: 0 });
        setDlProg({ current: 1, total: list.length });
        setLog(
          (x) =>
            x +
            t("tools.dlStart", { path: dlPath }) +
            ` — ${list.length} album(s)\n`,
        );
        try {
          const batchResults: {
            status: "ok" | "partial" | "failed";
            title: string;
          }[] = [];
          for (let i = 0; i < list.length; i += 1) {
            if (dlBatchStopRef.current) {
              setLog((x) => x + t("tools.dlBatchStoppedHint") + "\n");
              break;
            }
            const item = list[i]!;
            setDlProg({ current: i + 1, total: list.length });
            setDlTrackProg({ current: 0, total: 0 });
            setLog(
              (x) =>
                x +
                t("tools.dlBatchLine", {
                  i: i + 1,
                  n: list.length,
                  title: item.title,
                }),
            );
            const dlId = newStudioDownloadId();
            dlActiveDownloadIdRef.current = dlId;
            try {
              const r = await runYtdlpDownload(
                item.url,
                dlPath,
                (p) => setDlTrackProg({ current: p.current, total: p.total }),
                { downloadId: dlId, downloadKind: studioDlKind },
              );
              const detail = ytdlpLogDetailForUser(r);
              if (r.cancelled) {
                setLog((x) => x + t("tools.dlStoppedByUser") + "\n");
                break;
              }
              batchResults.push({
                status: !r.ok
                  ? "failed"
                  : (r.failedItems?.length ?? 0) > 0
                    ? "partial"
                    : "ok",
                title: item.title,
              });
              setLog(
                (x) =>
                  x +
                  (r.ok
                    ? t("tools.dlResultOk")
                    : t("tools.dlResultErr", { code: r.code }) +
                      (detail ? t("tools.dlErrDetail", { detail }) : "")) +
                  downloadSummaryLine(r),
              );
            } catch (e) {
              batchResults.push({ status: "failed", title: item.title });
              setLog(
                (x) =>
                  x +
                  t("tools.dlFail", { e: String((e as Error)?.message || e) }),
              );
            } finally {
              dlActiveDownloadIdRef.current = null;
            }
          }
          if (!dlBatchStopRef.current) {
            setDlProg({ current: list.length, total: list.length });
            setDlTrackProg(null);
          } else {
            setDlProg(null);
            setDlTrackProg(null);
          }
          setLog((x) => x + buildReleaseBatchSummaryLine(batchResults, t));
          await onReconcileLibrary({ mode: "now" });
        } finally {
          dlActiveDownloadIdRef.current = null;
        }
      } finally {
        setDlBusy(false);
        studioDlRunLatchRef.current = false;
      }
    })();
  };

  const toggleRelEntry = (id: string) => {
    setRelSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const dlMkdirBlockedInAlbum = Boolean(
    dlList && relPathLooksLikeAlbumFolderDest(dlList.path || ""),
  );

  const dlProgNorm = normalizeDlProgress(dlProg);
  const dlTrackNorm = normalizeTrackInAlbumProgress(dlTrackProg);
  /** Barra album + brani: stato download, non la modalità URL (si resetta al remount). */
  const showDualDlProgressBar =
    dlProgNorm != null &&
    dlProgNorm.tot >= 1 &&
    dlTrackProg != null;
  const singleDlBarNorm = showDualDlProgressBar
    ? null
    : dlProgNorm
      ? { ...dlProgNorm, hasTotal: true as const }
      : dlTrackNorm;
  const showDlProgressWrap = dlBusy || dlProg != null || dlTrackProg != null;

  const bridgePickForDownload = useCallback(
    (trimmed: string, kind: "album" | "song") => {
      clearDownloadDestination();
      setDlStudioMode("classic");
      setDlUrlMode(kind === "song" ? "single" : "playlist");
      setUrl(trimmed);
    },
    [clearDownloadDestination],
  );

  return {
    downloadSummaryLine,
    log,
    setLog,
    dlBusy,
    setDlBusy,
    dlProg,
    setDlProg,
    dlTrackProg,
    setDlTrackProg,
    mkBusy,
    setMkBusy,
    url,
    setUrl,
    dlStudioMode,
    setDlStudioMode,
    dlUrlMode,
    setDlUrlMode,
    dlList,
    dlDirQuery,
    setDlDirQuery,
    dlDirResults,
    dlDirSearchBusy,
    dlDirSearchOpen,
    setDlDirSearchOpen,
    dlDirSearchInputRef,
    dlPath,
    dlDestPicked,
    newDirName,
    setNewDirName,
    relPayload,
    relStreamComplete,
    relEnrichBusy,
    relSel,
    setRelSel,
    relQuery,
    setRelQuery,
    relLoadBusy,
    dlUrlPlaceholder,
    showMultiAlbumPicker,
    filteredRelEntries,
    filteredRelAlbums,
    filteredRelSongs,
    dlUrlValid,
    loadDlFs,
    toggleDlDirSearch,
    doCreateFolder,
    stopStudioDownload,
    hasValidDownloadDest,
    releasesDlBlockedAlbumFolder,
    exploreSingleBlockedArtistFolder,
    prepareExploreDownload,
    runDl,
    loadReleasesCatalog,
    runReleasesDl,
    toggleRelEntry,
    dlMkdirBlockedInAlbum,
    dlProgNorm,
    dlTrackNorm,
    showDualDlProgressBar,
    singleDlBarNorm,
    showDlProgressWrap,
    dlActiveDownloadIdRef,
    clearDownloadDestination,
    bridgePickForDownload,
  };
}
