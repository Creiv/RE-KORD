import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { usePlayer } from "../../../context/PlayerContext";
import type { useAppConfirm } from "../../../context/AppConfirmContext";
import {
  applyArtwork,
  applyDiscogsRelease,
  fetchAlbumInfo,
  fetchAlbumTracksInfo,
  fetchTrackInfo,
  pruneAlbumLibraryMetadataForAlbum,
  sanitizeTrackTitles,
  searchArtwork,
  searchDiscogsReleases,
} from "../../../lib/api";
import type {
  ArtworkHit,
  DiscogsReleaseCandidate,
} from "../../../lib/api";
import { fmtDate } from "../../../lib/metaFormat";
import { albumFolderFromTrack } from "../../../lib/trackPaths";
import { formatTrackGenresForDisplay } from "../../../lib/genres";
import type {
  LibArtist,
  LibraryEntityDelta,
} from "../../../types";
import {
  findLibTrack,
  artistNameForAlbumRelPath,
  K_COVER_ALB,
  LEGACY_COVER_ALB,
  migrateSessionKey,
  clearLegacySessionKeys,
  type StudioPane,
} from "../../../components/toolsViewShared";
import type { StudioPanelBaseDeps } from "./studioPanelShared";

export type StudioEnrichmentPanelDeps = StudioPanelBaseDeps & {
  p: ReturnType<typeof usePlayer>;
  appConfirm: ReturnType<typeof useAppConfirm>["confirm"];
  discogsConfigured: boolean;
};

export function useStudioEnrichmentPanel({
  library,
  onReconcileLibrary,
  onLibraryDelta,
  onLibraryDeltas,
  studioPane,
  tools,
  t,
  sortLocale,
  p,
  appConfirm,
  discogsConfigured,
}: StudioEnrichmentPanelDeps) {
  const {
    setLog,
    metaLog,
    setMetaLog,
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
  } = tools;

  const [artQuery, setArtQuery] = useState("");
  const [artRes, setArtRes] = useState<ArtworkHit[]>([]);
  const [metaArtistName, setMetaArtistName] = useState("");
  const [metaAlbumPath, setMetaAlbumPath] = useState("");
  const [metaArt, setMetaArt] = useState("");
  const [metaAlb, setMetaAlb] = useState("");
  const [coverPickArtist, setCoverPickArtist] = useState("");
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
  const [discogsPickerOpen, setDiscogsPickerOpen] = useState(false);
  const [discogsCandidates, setDiscogsCandidates] = useState<
    DiscogsReleaseCandidate[]
  >([]);
  const [metaOptionalOpen, setMetaOptionalOpen] = useState(false);

  useEffect(() => {
    if (!metaScanChoiceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMetaScanChoiceOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [metaScanChoiceOpen]);

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

  const libraryArtistsSorted = useMemo((): LibArtist[] => {
    if (!library) return [];
    return [...library.artists].sort((a, b) =>
      a.name.localeCompare(b.name, sortLocale, { sensitivity: "base" }),
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
    ],
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
        a.name.localeCompare(b.name, sortLocale, { numeric: true }),
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
        a.name.localeCompare(b.name, sortLocale, { numeric: true }),
      );
  }, [library, coverPickArtist, sortLocale]);

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
              s + t("tools.metaOkLine", { path: r.albumPath, date: fmtDate(d) }),
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
              s + t("tools.metaDiscogsFallbackErr", { e: String(e) }),
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
            }),
        );
        if (onLibraryDelta) {
          onLibraryDelta(
            {
              album: r.album,
              tracks: r.tracks,
            },
            false,
          );
        } else {
          void onReconcileLibrary({ mode: "debounced" });
        }
      })
      .catch((e) => setMetaLog((s) => s + t("tools.metaErr", { e: String(e) })))
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
        }),
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
            }),
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
        }),
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
            }),
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
                s + t("tools.trackMetaPruneAlbum", { path: albumPath, files }),
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
                }),
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
                }),
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
            }),
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
        }),
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
              `  ${c.albumRel} / ${c.fileName}: “${c.from}” → “${c.to}”`,
            );
          }
          if (rAll.changes.length > 100) {
            lines.push(
              "  " + t("tools.sanitizeMore", { n: rAll.changes.length - 100 }),
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
      .catch((e) => setLog((x) => x + t("tools.coverErr", { e: String(e) })))
      .finally(() => setArtBusy(false));
  };

  return {
    metaLog,
    setMetaLog,
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
    artQuery,
    setArtQuery,
    artRes,
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
    useCurrentForArt,
    setMetaFromCurrent,
    fetchOneAlbumMeta,
    applyDiscogsReleaseChoice,
    runMetaScanAll,
    fetchSelectedAlbumTracksMeta,
    runTrackScanAll,
    runPruneOrphanTrackMeta,
    runSanitizeTitles,
    doArtSearch,
    applyCover,
  };
}
