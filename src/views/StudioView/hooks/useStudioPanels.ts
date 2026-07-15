import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayer } from "../../../context/PlayerContext";
import { useToolsActivity } from "../../../context/ToolsActivityContext";
import { useAppConfirm } from "../../../context/AppConfirmContext";
import { useI18n } from "../../../i18n/useI18n";
import {
  applyArtwork,
  applyDiscogsRelease,
  createMusicSubdir,
  fetchConfig,
  fetchAlbumInfo,
  fetchAlbumTracksInfo,
  fetchLibraryCatalog,
  fetchMyLibrarySelection,
  patchMyLibrarySelection,
  fetchTrackInfo,
  fetchDownloadPreset,
  streamYoutubeReleasesList,
  getSelectedAccountId,
  listMusicDirs,
  fetchDownloadFlatCount,
  newStudioDownloadId,
  runYtdlpDownload,
  cancelStudioDownload,
  sanitizeTrackTitles,
  searchArtwork,
  searchDiscogsReleases,
  searchMusicDirs,
  pruneAlbumLibraryMetadataForAlbum,
  waitForLibraryEpoch,
} from "../../../lib/api";
import type {
  ArtworkHit,
  DiscogsReleaseCandidate,
  FsDirSearchResult,
  StudioDownloadKind,
  YoutubeExploreResult,
  YoutubeReleasesList,
} from "../../../lib/api";
import { fmtDate } from "../../../lib/metaFormat";
import { albumFolderFromTrack } from "../../../lib/trackPaths";
import { partitionYoutubeReleaseEntries } from "../../../lib/youtubeReleases";
import type {
  CatalogArtistEntry,
  LibArtist,
  LibraryCatalogResponse,
  LibraryEntityDelta,
  LibrarySelectionV1,
} from "../../../types";
import {
  buildDownloadSummaryLine,
  buildReleaseBatchSummaryLine,
} from "../../../lib/downloadLogSummary";
import { ytdlpLogDetailForUser } from "../../../lib/ytdlpLogFilter";
import { formatTrackGenresForDisplay } from "../../../lib/genres";
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
  findLibTrack,
  artistNameForAlbumRelPath,
  REKORD_DL_OK,
  REKORD_DL_OUT,
  K_COVER_ALB,
  LEGACY_DL_OK,
  LEGACY_DL_OUT,
  LEGACY_COVER_ALB,
  REKORD_DL_STUDIO_MODE,
  REKORD_CATALOG_STUDIO_MODE,
  migrateSessionKey,
  migrateSessionFlag,
  clearLegacySessionKeys,
  readStoredDlStudioMode,
  readStoredCatalogStudioMode,
  isRekordClientEmbed,
  catalogArtistNeedsAttention,
  exploreScopeForItem,
  exploreDownloadPreamble,
  buildReleasesArtistFolderConfirm,
  prepareStudioDownload,
  normalizeDlProgress,
  normalizeTrackInAlbumProgress,
  type DlStudioMode,
  type CatalogStudioMode,
  type StudioPane,
} from "../../../components/toolsViewShared";
import type { StudioViewProps } from "../types";

export function useStudioPanels(
  {
    library,
    libraryIndex,
    onReconcileLibrary,
    onLibraryDelta,
    onLibraryDeltas,
  }: StudioViewProps,
  studioPane: StudioPane,
  setStudioPane: (pane: StudioPane) => void,
) {
  const p = usePlayer();
  const { t, sortLocale } = useI18n();
  const downloadSummaryLine = useCallback(
    (r: Parameters<typeof buildDownloadSummaryLine>[0]) =>
      buildDownloadSummaryLine(r, t),
    [t],
  );
  const { confirm: appConfirm } = useAppConfirm();
  const {
    log,
    setLog,
    metaLog,
    setMetaLog,
    dlBusy,
    setDlBusy,
    dlProg,
    setDlProg,
    dlTrackProg,
    setDlTrackProg,
    mkBusy,
    setMkBusy,
    artBusy,
    setArtBusy,
    metaBusy,
    setMetaBusy,
    metaAllBusy,
    setMetaAllBusy,
    metaScanProg,
    setMetaScanProg,
    trackMetaBusy,
    setTrackMetaBusy,
    trackAllBusy,
    setTrackAllBusy,
    trackScanProg,
    setTrackScanProg,
    titleSanBusy,
    setTitleSanBusy,
    trackPruneBusy,
    setTrackPruneBusy,
    trackPruneProg,
    setTrackPruneProg,
    stopMetaAll,
    stopTrackAll,
    stopTrackPrune,
  } = useToolsActivity();
  const [url, setUrl] = useState("");
  const [dlStudioMode, setDlStudioMode] = useState<DlStudioMode>(
    readStoredDlStudioMode,
  );
  const [catalogStudioMode, setCatalogStudioMode] =
    useState<CatalogStudioMode>(readStoredCatalogStudioMode);
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
  const [catalogLockedByEnv, setCatalogLockedByEnv] = useState(false);
  const [serverLocalAccess, setServerLocalAccess] = useState(false);
  const [localSessionAccount, setLocalSessionAccount] = useState<string | null>(
    () => getSelectedAccountId()
  );
  const [catalogData, setCatalogData] = useState<LibraryCatalogResponse | null>(
    null,
  );
  const [mySelection, setMySelection] = useState<LibrarySelectionV1 | null>(
    null,
  );
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [catalogMsg, setCatalogMsg] = useState<string | null>(null);
  const [catalogArtistDetail, setCatalogArtistDetail] =
    useState<CatalogArtistEntry | null>(null);
  const [catalogArtistQuery, setCatalogArtistQuery] = useState("");
  const [catalogArtistOnlyAttention, setCatalogArtistOnlyAttention] =
    useState(true);
  const [artQuery, setArtQuery] = useState("");
  const [artRes, setArtRes] = useState<ArtworkHit[]>([]);
  const [newDirName, setNewDirName] = useState("");
  const [metaArtistName, setMetaArtistName] = useState("");
  const [metaAlbumPath, setMetaAlbumPath] = useState("");
  const [metaArt, setMetaArt] = useState("");
  const [metaAlb, setMetaAlb] = useState("");
  const [coverPickArtist, setCoverPickArtist] = useState("");
  const [relPayload, setRelPayload] = useState<YoutubeReleasesList | null>(
    null
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
  const catalogLoadedAccountRef = useRef<string | null>(null);
  const dlActiveDownloadIdRef = useRef<string | null>(null);
  const dlBatchStopRef = useRef(false);
  const studioDlRunLatchRef = useRef(false);
  const [albumForCover, setAlbumForCover] = useState(() => {
    try {
      return migrateSessionKey(K_COVER_ALB, LEGACY_COVER_ALB) ?? "";
    } catch {
      return "";
    }
  });
  const [metaScanChoiceOpen, setMetaScanChoiceOpen] = useState<
    null | "album" | "track"
  >(null);
  const [discogsConfigured, setDiscogsConfigured] = useState(false);
  const [discogsPickerOpen, setDiscogsPickerOpen] = useState(false);
  const [discogsCandidates, setDiscogsCandidates] = useState<
    DiscogsReleaseCandidate[]
  >([]);
  const [metaOptionalOpen, setMetaOptionalOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(REKORD_DL_STUDIO_MODE, dlStudioMode);
    } catch {
      /* ignore */
    }
  }, [dlStudioMode]);

  useEffect(() => {
    try {
      localStorage.setItem(REKORD_CATALOG_STUDIO_MODE, catalogStudioMode);
    } catch {
      /* ignore */
    }
  }, [catalogStudioMode]);

  useEffect(() => {
    if (!metaScanChoiceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMetaScanChoiceOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [metaScanChoiceOpen]);

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

  const pickCatalogWebForDownload = useCallback(
    (pickUrl: string, kind: "album" | "song") => {
      const trimmed = pickUrl.trim();
      if (!trimmed) return;
      clearDownloadDestination();
      setDlStudioMode("classic");
      setDlUrlMode(kind === "song" ? "single" : "playlist");
      setUrl(trimmed);
      setStudioPane("download");
    },
    [clearDownloadDestination],
  );

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

  const prevMetaAlbumPathRef = useRef(metaAlbumPath);
  useEffect(() => {
    if (!library || !metaAlbumPath) return;
    if (metaAlbumPath === prevMetaAlbumPathRef.current) return;
    prevMetaAlbumPathRef.current = metaAlbumPath;
    const name = artistNameForAlbumRelPath(library, metaAlbumPath);
    if (name) setMetaArtistName(name);
  }, [library, metaAlbumPath]);

  const prevAlbumForCoverRef = useRef(albumForCover);
  useEffect(() => {
    if (!library || !albumForCover) return;
    if (albumForCover === prevAlbumForCoverRef.current) return;
    prevAlbumForCoverRef.current = albumForCover;
    const name = artistNameForAlbumRelPath(library, albumForCover);
    if (name) setCoverPickArtist(name);
  }, [library, albumForCover]);

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

  useEffect(() => {
    try {
      if (albumForCover) {
        sessionStorage.setItem(K_COVER_ALB, albumForCover);
      } else {
        sessionStorage.removeItem(K_COVER_ALB);
        clearLegacySessionKeys();
      }
    } catch {
      /* ignore */
    }
  }, [albumForCover]);

  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setCatalogLockedByEnv(c.lockedByEnv);
        setServerLocalAccess(Boolean(c.localAccess) && !isRekordClientEmbed());
        setDiscogsConfigured(Boolean(c.discogsConfigured));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const h = () => setLocalSessionAccount(getSelectedAccountId());
    window.addEventListener("rekord-account-session-changed", h);
    return () => window.removeEventListener("rekord-account-session-changed", h);
  }, []);

  const libraryArtistsSorted = useMemo((): LibArtist[] => {
    if (!library) return [];
    return [...library.artists].sort((a, b) =>
      a.name.localeCompare(b.name, sortLocale, { sensitivity: "base" })
    );
  }, [library, sortLocale]);

  const studioMetaBusy = useMemo(
    () =>
      metaBusy ||
      metaAllBusy ||
      trackMetaBusy ||
      trackAllBusy ||
      trackPruneBusy ||
      titleSanBusy,
    [
      metaBusy,
      metaAllBusy,
      trackMetaBusy,
      trackAllBusy,
      trackPruneBusy,
      titleSanBusy,
    ]
  );

  const metaAlbumsForPick = useMemo(() => {
    if (!library || !metaArtistName)
      return [] as { relPath: string; name: string }[];
    const ar = library.artists.find((x) => x.name === metaArtistName);
    if (!ar) return [];
    return ar.albums
      .filter((al) => al.id !== "__loose__")
      .map((al) => ({
        relPath: al.relPath || `${ar.name}/${al.name}`,
        name: al.name,
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
  }, [library, metaArtistName, sortLocale]);

  const coverAlbumsForPick = useMemo(() => {
    if (!library || !coverPickArtist)
      return [] as { relPath: string; name: string }[];
    const ar = library.artists.find((x) => x.name === coverPickArtist);
    if (!ar) return [];
    return ar.albums
      .filter((al) => al.id !== "__loose__")
      .map((al) => ({
        relPath: al.relPath || `${ar.name}/${al.name}`,
        name: al.name,
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
  }, [library, coverPickArtist, sortLocale]);

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
        entry.url.toLowerCase().includes(q)
    );
  }, [relPayload?.entries, relQuery]);

  const { albums: filteredRelAlbums, songs: filteredRelSongs } = useMemo(
    () => partitionYoutubeReleaseEntries(filteredRelEntries),
    [filteredRelEntries],
  );

  const dlUrlValid = useMemo(
    () => urlMatchesStudioDlMode(url, "video", dlUrlMode),
    [url, dlUrlMode]
  );

  const catalogDataRef = useRef(catalogData);
  const mySelectionRef = useRef(mySelection);
  catalogDataRef.current = catalogData;
  mySelectionRef.current = mySelection;

  const loadCatalogPane = useCallback((force = false) => {
    const accountKey = localSessionAccount || "__default__";
    if (
      !force &&
      catalogLoadedAccountRef.current === accountKey &&
      catalogDataRef.current &&
      mySelectionRef.current
    ) {
      return;
    }
    setCatalogBusy(true);
    setCatalogErr(null);
    setCatalogArtistDetail(null);
    Promise.all([fetchLibraryCatalog({ summary: true }), fetchMyLibrarySelection()])
      .then(([cat, sel]) => {
        setCatalogData(cat);
        setMySelection(sel);
        catalogLoadedAccountRef.current = accountKey;
      })
      .catch((e) => {
        setCatalogErr(
          t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
        );
        setCatalogData(null);
        setMySelection(null);
      })
      .finally(() => setCatalogBusy(false));
  }, [localSessionAccount, t]);

  const openCatalogArtist = useCallback(
    (artistId: string) => {
      setCatalogBusy(true);
      setCatalogErr(null);
      fetchLibraryCatalog({ artistId })
        .then((cat) => {
          const detail =
            cat.artists.find((artist: CatalogArtistEntry) => artist.id === artistId) ??
            catalogData?.artists.find(
              (artist: CatalogArtistEntry) => artist.id === artistId,
            ) ??
            cat.artists[0] ??
            null;
          setCatalogArtistDetail(detail);
        })
        .catch((e) => {
          setCatalogErr(
            t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
          );
        })
        .finally(() => setCatalogBusy(false));
    },
    [catalogData?.artists, t],
  );

  useEffect(() => {
    if (studioPane !== "catalog") return;
    if (catalogStudioMode !== "local") return;
    loadCatalogPane();
  }, [studioPane, catalogStudioMode, loadCatalogPane, localSessionAccount]);

  const afterCatalogPatch = useCallback(() => {
    setCatalogMsg(t("tools.catalogUpdated"));
    if (catalogArtistDetail) {
      void fetchLibraryCatalog({ artistId: catalogArtistDetail.id })
        .then((cat) => setCatalogArtistDetail(cat.artists[0] ?? null))
        .catch(() => {});
      void fetchMyLibrarySelection().then(setMySelection).catch(() => {});
    } else {
      loadCatalogPane(true);
    }
    void onReconcileLibrary({ mode: "debounced" });
  }, [catalogArtistDetail, loadCatalogPane, onReconcileLibrary, t]);

  const addArtistCatalog = useCallback(
    (artistId: string) => {
      setCatalogBusy(true);
      setCatalogErr(null);
      patchMyLibrarySelection({ addArtists: [artistId] })
        .then((s) => {
          setMySelection(s);
          afterCatalogPatch();
        })
        .catch((e) => {
          setCatalogErr(
            t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
          );
        })
        .finally(() => setCatalogBusy(false));
    },
    [afterCatalogPatch, t],
  );

  const removeArtistCatalog = useCallback(
    (artistId: string) => {
      setCatalogBusy(true);
      setCatalogErr(null);
      patchMyLibrarySelection({
        includeAll: false,
        removeArtists: [artistId],
      })
        .then((s) => {
          setMySelection(s);
          afterCatalogPatch();
        })
        .catch((e) => {
          setCatalogErr(
            t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
          );
        })
        .finally(() => setCatalogBusy(false));
    },
    [afterCatalogPatch, t],
  );

  const addAlbumCatalog = useCallback(
    (relPath: string) => {
      setCatalogBusy(true);
      setCatalogErr(null);
      patchMyLibrarySelection({ addAlbums: [relPath] })
        .then((s) => {
          setMySelection(s);
          afterCatalogPatch();
        })
        .catch((e) => {
          setCatalogErr(
            t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
          );
        })
        .finally(() => setCatalogBusy(false));
    },
    [afterCatalogPatch, t],
  );

  const removeAlbumCatalog = useCallback(
    (relPath: string) => {
      setCatalogBusy(true);
      setCatalogErr(null);
      patchMyLibrarySelection({ removeAlbums: [relPath] })
        .then((s) => {
          setMySelection(s);
          afterCatalogPatch();
        })
        .catch((e) => {
          setCatalogErr(
            t("tools.catalogErr", { e: String((e as Error)?.message || e) }),
          );
        })
        .finally(() => setCatalogBusy(false));
    },
    [afterCatalogPatch, t],
  );

  const fillCoverFromCurrentPlayback = useCallback(() => {
    const current = p.current;
    if (!current) return;
    setArtQuery([current.artist, current.album].filter(Boolean).join(" "));
    setCoverPickArtist(current.artist);
    const folder = albumFolderFromTrack(current);
    if (folder) setAlbumForCover(folder);
  }, [p]);

  const fillMetaFromCurrentPlayback = useCallback(
    (options?: { log?: boolean }) => {
      const logFeedback = options?.log ?? false;
      const current = p.current;
      if (!current?.relPath) {
        if (logFeedback) setMetaLog(t("tools.metaNoTrack"));
        return;
      }
      setMetaArt(current.artist);
      setMetaAlb(current.album);
      setMetaArtistName(current.artist);
      const folder = albumFolderFromTrack(current);
      if (folder) {
        setMetaAlbumPath(folder);
        if (logFeedback) setMetaLog(t("tools.metaFromTrackOk"));
      } else if (logFeedback) {
        setMetaLog(t("tools.metaNoFolder"));
      }
    },
    [p, setMetaLog, t],
  );

  const useCurrentForArt = () => {
    fillCoverFromCurrentPlayback();
  };

  const setMetaFromCurrent = () => {
    fillMetaFromCurrentPlayback({ log: true });
  };

  const prevStudioPaneRef = useRef<StudioPane | null>(null);
  useEffect(() => {
    const prev = prevStudioPaneRef.current;
    prevStudioPaneRef.current = studioPane;
    if (studioPane === "meta" && prev !== "meta") {
      fillMetaFromCurrentPlayback();
    }
    if (studioPane === "covers" && prev !== "covers") {
      fillCoverFromCurrentPlayback();
    }
  }, [studioPane, fillMetaFromCurrentPlayback, fillCoverFromCurrentPlayback]);

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

  const fetchOneAlbumMeta = () => {
    if (!metaAlbumPath.trim()) {
      setMetaLog(t("tools.metaPickAlbum"));
      return;
    }
    const runFallbackFetch = () => {
      setMetaBusy(true);
      fetchAlbumInfo(metaAlbumPath.trim(), metaArt.trim(), metaAlb.trim())
        .then((r) => {
          const d = r.meta?.date;
          setMetaLog(
            (s) =>
              s + t("tools.metaOkLine", { path: r.albumPath, date: fmtDate(d) })
          );
          if (r.album && onLibraryDelta) {
            onLibraryDelta({ album: r.album }, false);
          } else {
            void onReconcileLibrary({ mode: "debounced" });
          }
        })
        .catch((e) => setMetaLog((s) => s + t("tools.metaErr", { e: String(e) })))
        .finally(() => setMetaBusy(false));
    };
    if (discogsConfigured) {
      setMetaBusy(true);
      searchDiscogsReleases(metaArt.trim(), metaAlb.trim())
        .then((r) => {
          if (!r.candidates?.length) {
            setMetaLog((s) => s + t("tools.metaDiscogsFallback"));
            runFallbackFetch();
            return;
          }
          setDiscogsCandidates(r.candidates);
          setDiscogsPickerOpen(true);
          setMetaBusy(false);
        })
        .catch((e) => {
          setMetaLog(
            (s) =>
              s + t("tools.metaDiscogsFallbackErr", { e: String(e) })
          );
          runFallbackFetch();
        });
      return;
    }
    runFallbackFetch();
  };

  const applyDiscogsReleaseChoice = (releaseId: number) => {
    if (!metaAlbumPath.trim()) return;
    setDiscogsPickerOpen(false);
    setMetaBusy(true);
    applyDiscogsRelease(metaAlbumPath.trim(), releaseId)
      .then((r) => {
        const d = r.meta?.date;
        setMetaLog(
          (s) =>
            s +
            t("tools.metaDiscogsOkLine", {
              path: r.albumPath,
              date: fmtDate(d),
              id: String(releaseId),
            })
        );
        if (onLibraryDelta) {
          onLibraryDelta(
            {
              album: r.album,
              tracks: r.tracks,
            },
            false
          );
        } else {
          void onReconcileLibrary({ mode: "debounced" });
        }
      })
      .catch((e) => setMetaLog((s) => s + t("tools.metaErr", { e })))
      .finally(() => setMetaBusy(false));
  };

  const runMetaScanAll = async (rescanAll: boolean) => {
    if (!library) return;
    stopMetaAll.current = false;
    setMetaAllBusy(true);
    setMetaScanProg(null);
    const list: { path: string; artist: string; album: string }[] = [];
    for (const a of library.artists) {
      for (const al of a.albums) {
        if (al.id === "__loose__") continue;
        list.push({
          path: `${a.name}/${al.name}`,
          artist: a.name,
          album: al.name,
        });
      }
    }
    const toFetch = rescanAll
      ? list
      : list.filter((row) => {
          const ar = library.artists.find((x) => x.name === row.artist);
          const al = ar?.albums.find((x) => x.name === row.album);
          return !al?.hasAlbumMeta;
        });
    const skipped = list.length - toFetch.length;
    setMetaLog(
      (s) =>
        s +
        (rescanAll ? t("tools.metaScanRescanAllBanner") : "") +
        t("tools.metaScanStart", {
          fetch: toFetch.length,
          skip: skipped > 0 ? t("tools.metaScanSkip", { n: skipped }) : "",
        })
    );
    if (toFetch.length === 0) {
      setMetaAllBusy(false);
      setMetaLog((s) => s + t("tools.metaNoAlbums"));
      return;
    }
    const scanDeltas: LibraryEntityDelta[] = [];
    const flushScanDeltas = () => {
      if (!scanDeltas.length) return;
      if (onLibraryDeltas) {
        onLibraryDeltas(scanDeltas, false);
      } else {
        for (const delta of scanDeltas) {
          onLibraryDelta?.(delta, false);
        }
      }
      scanDeltas.length = 0;
    };
    for (let i = 0; i < toFetch.length; i += 1) {
      if (stopMetaAll.current) {
        setMetaLog((s) => s + t("tools.metaUserStop"));
        setMetaScanProg(null);
        setMetaAllBusy(false);
        flushScanDeltas();
        void onReconcileLibrary({ mode: "now" });
        return;
      }
      const row = toFetch[i]!;
      setMetaScanProg({ current: i + 1, total: toFetch.length });
      try {
        const r = await fetchAlbumInfo(row.path, row.artist, row.album);
        if (r.album) {
          scanDeltas.push({ album: r.album });
        }
      } catch (e) {
        setMetaLog(
          (s) =>
            s +
            t("tools.metaScanItemErr", {
              i: i + 1,
              total: toFetch.length,
              path: row.path,
              err: String((e as Error)?.message || e),
            })
        );
      }
    }
    setMetaScanProg(null);
    setMetaAllBusy(false);
    flushScanDeltas();
    setMetaLog((s) => s + t("tools.metaScanDone"));
    void onReconcileLibrary({ mode: "now" });
  };

  const fetchSelectedAlbumTracksMeta = async () => {
    if (!metaAlbumPath.trim()) {
      setMetaLog((s) => s + t("tools.metaPickAlbum"));
      return;
    }
    setTrackMetaBusy(true);
    setTrackScanProg({ current: 0, total: 1 });
    setMetaLog(
      (s) =>
        s +
        t("tools.metaAlbumTracksStart", { path: metaAlbumPath.trim() }),
    );
    try {
      const r = await fetchAlbumTracksInfo(
        metaAlbumPath.trim(),
        metaArt.trim(),
        metaAlb.trim(),
      );
      const total = r.fetched + r.failed;
      if (total > 0) {
        setTrackScanProg({ current: total, total });
      }
      for (const track of r.tracks) {
        if (track && onLibraryDelta) {
          onLibraryDelta({ track }, false);
        }
      }
      for (const err of r.errors || []) {
        setMetaLog(
          (s) =>
            s +
            t("tools.metaAlbumTrackErr", {
              path: err.relPath,
              e: err.error,
            }),
        );
      }
      setMetaLog(
        (s) =>
          s +
          t("tools.metaAlbumTracksDone", {
            ok: r.fetched,
            err: r.failed,
          }),
      );
      void onReconcileLibrary({ mode: "now" });
    } catch (e) {
      setMetaLog((s) => s + t("tools.metaTrackErr", { e: String(e) }));
    } finally {
      setTrackMetaBusy(false);
      setTrackScanProg(null);
    }
  };

  const runTrackScanAll = async (rescanAll: boolean) => {
    if (!library) return;
    stopTrackAll.current = false;
    setTrackAllBusy(true);
    setTrackScanProg(null);
    const rels: string[] = [];
    for (const a of library.artists) {
      for (const al of a.albums) {
        for (const t of al.tracks) rels.push(t.relPath);
      }
    }
    const toFetch = rescanAll
      ? rels
      : rels.filter((rel) => {
          const tr = findLibTrack(library, rel);
          const m = tr?.meta;
          if (!m) return true;
          return !(formatTrackGenresForDisplay(m.genre) || m.releaseDate);
        });
    const skippedT = rels.length - toFetch.length;
    setMetaLog(
      (s) =>
        s +
        (rescanAll ? t("tools.trackScanRescanAllBanner") : "") +
        t("tools.trackScanStart", {
          fetch: toFetch.length,
          skip: skippedT > 0 ? t("tools.trackScanSkip", { n: skippedT }) : "",
        })
    );
    if (toFetch.length === 0) {
      setTrackAllBusy(false);
      setMetaLog((s) => s + t("tools.trackNoUpdate"));
      return;
    }
    for (let i = 0; i < toFetch.length; i += 1) {
      if (stopTrackAll.current) {
        setMetaLog((s) => s + t("tools.trackScanStop"));
        setTrackScanProg(null);
        setTrackAllBusy(false);
        void onReconcileLibrary({ mode: "now" });
        return;
      }
      const rel = toFetch[i]!;
      setTrackScanProg({ current: i + 1, total: toFetch.length });
      try {
        const r = await fetchTrackInfo(rel);
        if (r.track && onLibraryDelta) {
          onLibraryDelta({ track: r.track }, false);
        }
      } catch (e) {
        setMetaLog(
          (s) =>
            s +
            t("tools.trackScanItemErr", {
              i: i + 1,
              total: toFetch.length,
              path: rel,
              err: String((e as Error)?.message || e),
            })
        );
      }
      if (i < toFetch.length - 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    setTrackScanProg(null);
    setTrackAllBusy(false);
    setMetaLog((s) => s + t("tools.trackScanDone"));
    void onReconcileLibrary({ mode: "now" });
  };

  const runPruneOrphanTrackMeta = async () => {
    if (!library) return;
    if (
      !(await appConfirm({
        message: t("tools.trackMetaPruneConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    stopTrackPrune.current = false;
    setTrackPruneBusy(true);
    setTrackPruneProg(null);
    const list: string[] = [];
    for (const a of library.artists) {
      for (const al of a.albums) {
        const folder = al.relPath?.trim() || `${a.name}/${al.name}`;
        if (folder) list.push(folder);
      }
    }
    setMetaLog((s) => s + t("tools.trackMetaPruneStart", { n: list.length }));
    let albumsTouched = 0;
    let keysRemoved = 0;
    let orderingFieldsCleared = 0;
    let releaseTracklistsCleared = 0;
    let jsonFieldsMerged = 0;
    let jsonTracksMerged = 0;
    let jsonFilesRemoved = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (stopTrackPrune.current) {
        setMetaLog((s) => s + t("tools.trackMetaPruneStop"));
        setTrackPruneProg(null);
        setTrackPruneBusy(false);
        void onReconcileLibrary({ mode: "now" });
        return;
      }
      const albumPath = list[i]!;
      setTrackPruneProg({ current: i + 1, total: list.length });
      try {
        const r = await pruneAlbumLibraryMetadataForAlbum(albumPath);
        const touched =
          r.removed.length > 0 ||
          r.expectedTracksCleared ||
          r.trackOrderingFieldsCleared > 0 ||
          r.albumFieldsMerged > 0 ||
          r.tracksMerged > 0 ||
          r.jsonFilesRemoved > 0 ||
          r.jsonFilesTrimmed > 0;
        if (touched) {
          albumsTouched += 1;
          keysRemoved += r.removed.length;
          orderingFieldsCleared += r.trackOrderingFieldsCleared;
          jsonFieldsMerged += r.albumFieldsMerged;
          jsonTracksMerged += r.tracksMerged;
          jsonFilesRemoved += r.jsonFilesRemoved;
          if (r.expectedTracksCleared) releaseTracklistsCleared += 1;
          if (r.removed.length) {
            const files =
              r.removed.length > 6
                ? `${r.removed.slice(0, 6).join(", ")}…`
                : r.removed.join(", ");
            setMetaLog(
              (s) =>
                s + t("tools.trackMetaPruneAlbum", { path: albumPath, files })
            );
          }
          if (r.expectedTracksCleared || r.trackOrderingFieldsCleared > 0) {
            setMetaLog(
              (s) =>
                s +
                t("tools.trackMetaPruneAlbumOrdering", {
                  path: albumPath,
                  tracks: r.trackOrderingFieldsCleared,
                  release: r.expectedTracksCleared ? "yes" : "no",
                })
            );
          }
          if (r.albumFieldsMerged > 0 || r.tracksMerged > 0 || r.jsonFilesRemoved > 0) {
            setMetaLog(
              (s) =>
                s +
                t("tools.trackMetaPruneAlbumJson", {
                  path: albumPath,
                  fields: r.albumFieldsMerged,
                  tracks: r.tracksMerged,
                  files: r.jsonFilesRemoved,
                })
            );
          }
        }
      } catch (e) {
        setMetaLog(
          (s) =>
            s +
            t("tools.trackMetaPruneItemErr", {
              i: i + 1,
              total: list.length,
              path: albumPath,
              err: String((e as Error)?.message || e),
            })
        );
      }
    }
    setTrackPruneProg(null);
    setTrackPruneBusy(false);
    setMetaLog(
      (s) =>
        s +
        t("tools.trackMetaPruneDone", {
          a: albumsTouched,
          k: keysRemoved,
          o: orderingFieldsCleared,
          e: releaseTracklistsCleared,
          f: jsonFieldsMerged,
          t: jsonTracksMerged,
          j: jsonFilesRemoved,
        })
    );
    void onReconcileLibrary({ mode: "now" });
  };

  const runSanitizeTitles = async (scope: "album" | "all", dryRun: boolean) => {
    if (scope === "album" && !metaAlbumPath.trim()) {
      setMetaLog((s) => s + t("tools.sanitizePickAlbum"));
      return;
    }
    setTitleSanBusy(true);
    try {
      if (scope === "all") {
        const rAll = await sanitizeTrackTitles({ scope: "all", dryRun });
        setMetaLog((s) => {
          const head = dryRun
            ? t("tools.sanitizeHeadPreviewLib", {
                a: rAll.albumsScanned,
                c: rAll.changes.length,
              })
            : t("tools.sanitizeHeadApplyLib", {
                a: rAll.albumsScanned,
                c: rAll.changes.length,
              });
          if (rAll.changes.length === 0) {
            return s + head + t("tools.sanitizeNoFixLib");
          }
          const lines: string[] = [s + head];
          const show = rAll.changes.slice(0, 100);
          for (const c of show) {
            lines.push(
              `  ${c.albumRel} / ${c.fileName}: “${c.from}” → “${c.to}”`
            );
          }
          if (rAll.changes.length > 100) {
            lines.push(
              "  " + t("tools.sanitizeMore", { n: rAll.changes.length - 100 })
            );
          }
          lines.push("");
          return lines.join("\n");
        });
      } else {
        const r1 = await sanitizeTrackTitles({
          scope: "album",
          albumPath: metaAlbumPath.trim(),
          dryRun,
        });
        setMetaLog((s) => {
          const head = dryRun
            ? t("tools.sanitizeHeadPreviewAlb", { path: r1.albumPath })
            : t("tools.sanitizeHeadApplyAlb", { path: r1.albumPath });
          if (r1.changes.length === 0) {
            return s + head + t("tools.sanitizeNoFixAlb");
          }
          let acc = s + head;
          for (const c of r1.changes) {
            acc += `  ${c.fileName}: “${c.from}” → “${c.to}”\n`;
          }
          if (!dryRun) acc += t("tools.sanitizeRefreshHint");
          return acc;
        });
      }
      if (!dryRun) void onReconcileLibrary({ mode: "now" });
    } catch (e) {
      setMetaLog((s) => s + t("tools.sanitizeErr", { e: String(e) }));
    } finally {
      setTitleSanBusy(false);
    }
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
                })
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
              })
          );
          const r = await runYtdlpDownload(
            url.trim(),
            outputDir,
            (p) => setDlProg({ current: p.current, total: p.total }),
            { downloadId: dlId, downloadKind: studioDlKind }
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
              x + t("tools.dlFail", { e: String((e as Error)?.message || e) })
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
              p ? { ...p, entries: [...p.entries, ...batch] } : null
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
              "\n"
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
          x + t("tools.pickerErr", { e: String((e as Error)?.message || e) })
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
            ` — ${list.length} album(s)\n`
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
                })
            );
            const dlId = newStudioDownloadId();
            dlActiveDownloadIdRef.current = dlId;
            try {
              const r = await runYtdlpDownload(
                item.url,
                dlPath,
                (p) => setDlTrackProg({ current: p.current, total: p.total }),
                { downloadId: dlId, downloadKind: studioDlKind }
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
                  downloadSummaryLine(r)
              );
            } catch (e) {
              batchResults.push({ status: "failed", title: item.title });
              setLog(
                (x) =>
                  x +
                  t("tools.dlFail", { e: String((e as Error)?.message || e) })
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

  const doArtSearch = () => {
    const q = artQuery.trim();
    if (q.length < 1) return;
    setArtBusy(true);
    searchArtwork({ q })
      .then(setArtRes)
      .catch(() => setArtRes([]))
      .finally(() => setArtBusy(false));
  };

  const applyCover = (imageUrl: string) => {
    if (!albumForCover) {
      setLog((x) => x + t("tools.coverPickDest"));
      return;
    }
    setArtBusy(true);
    applyArtwork(albumForCover, imageUrl)
      .then((delta) => {
        setLog((x) => x + t("tools.coverSaved", { path: albumForCover }));
        if (onLibraryDelta) onLibraryDelta(delta, false);
        else void onReconcileLibrary({ mode: "debounced" });
      })
      .catch((e) => setLog((x) => x + t("tools.coverErr", { e })))
      .finally(() => setArtBusy(false));
  };

  const filteredCatalogArtists = useMemo(() => {
    if (!catalogData?.artists.length) return [];
    const q = catalogArtistQuery.trim().toLowerCase();
    return catalogData.artists.filter((ar) => {
      if (q && !ar.name.toLowerCase().includes(q)) return false;
      if (
        catalogArtistOnlyAttention &&
        !catalogArtistNeedsAttention(ar, libraryIndex, mySelection)
      ) {
        return false;
      }
      return true;
    });
  }, [
    catalogData,
    catalogArtistQuery,
    catalogArtistOnlyAttention,
    libraryIndex,
    mySelection,
  ]);

  return {
    t,
    sortLocale,
    p,
    studioPane,
    setStudioPane,
    library,
    libraryIndex,
    onReconcileLibrary,
    onLibraryDelta,
    onLibraryDeltas,
    downloadSummaryLine,
    log,
    setLog,
    metaLog,
    setMetaLog,
    dlBusy,
    setDlBusy,
    dlProg,
    setDlProg,
    dlTrackProg,
    setDlTrackProg,
    mkBusy,
    setMkBusy,
    artBusy,
    setArtBusy,
    metaBusy,
    setMetaBusy,
    metaAllBusy,
    setMetaAllBusy,
    metaScanProg,
    setMetaScanProg,
    trackMetaBusy,
    setTrackMetaBusy,
    trackAllBusy,
    setTrackAllBusy,
    trackScanProg,
    setTrackScanProg,
    titleSanBusy,
    setTitleSanBusy,
    trackPruneBusy,
    setTrackPruneBusy,
    trackPruneProg,
    setTrackPruneProg,
    stopMetaAll,
    stopTrackAll,
    stopTrackPrune,
    url,
    setUrl,
    dlStudioMode,
    setDlStudioMode,
    catalogStudioMode,
    setCatalogStudioMode,
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
    catalogLockedByEnv,
    serverLocalAccess,
    localSessionAccount,
    catalogData,
    mySelection,
    catalogBusy,
    catalogErr,
    catalogMsg,
    catalogArtistDetail,
    setCatalogArtistDetail,
    catalogArtistQuery,
    setCatalogArtistQuery,
    catalogArtistOnlyAttention,
    setCatalogArtistOnlyAttention,
    artQuery,
    setArtQuery,
    artRes,
    newDirName,
    setNewDirName,
    metaArtistName,
    setMetaArtistName,
    metaAlbumPath,
    setMetaAlbumPath,
    metaArt,
    setMetaArt,
    metaAlb,
    setMetaAlb,
    coverPickArtist,
    setCoverPickArtist,
    relPayload,
    relStreamComplete,
    relEnrichBusy,
    relSel,
    setRelSel,
    relQuery,
    setRelQuery,
    relLoadBusy,
    albumForCover,
    setAlbumForCover,
    metaScanChoiceOpen,
    setMetaScanChoiceOpen,
    discogsConfigured,
    discogsPickerOpen,
    setDiscogsPickerOpen,
    discogsCandidates,
    metaOptionalOpen,
    setMetaOptionalOpen,
    libraryArtistsSorted,
    studioMetaBusy,
    metaAlbumsForPick,
    coverAlbumsForPick,
    dlUrlPlaceholder,
    showMultiAlbumPicker,
    filteredRelEntries,
    filteredRelAlbums,
    filteredRelSongs,
    dlUrlValid,
    loadCatalogPane,
    openCatalogArtist,
    pickCatalogWebForDownload,
    addArtistCatalog,
    removeArtistCatalog,
    addAlbumCatalog,
    removeAlbumCatalog,
    useCurrentForArt,
    setMetaFromCurrent,
    loadDlFs,
    toggleDlDirSearch,
    doCreateFolder,
    fetchOneAlbumMeta,
    applyDiscogsReleaseChoice,
    runMetaScanAll,
    fetchSelectedAlbumTracksMeta,
    runTrackScanAll,
    runPruneOrphanTrackMeta,
    runSanitizeTitles,
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
    doArtSearch,
    applyCover,
    filteredCatalogArtists,
    dlActiveDownloadIdRef,
  };
}
