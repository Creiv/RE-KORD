import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchLibraryCatalog,
  fetchMyLibrarySelection,
  getSelectedAccountId,
  patchMyLibrarySelection,
} from "../../../lib/api";
import type {
  CatalogArtistEntry,
  LibraryCatalogResponse,
  LibrarySelectionV1,
} from "../../../types";
import {
  REKORD_CATALOG_STUDIO_MODE,
  catalogArtistNeedsAttention,
  readStoredCatalogStudioMode,
  type CatalogStudioMode,
} from "../../../components/toolsViewShared";
import type { StudioPanelBaseDeps } from "./studioPanelShared";

export type StudioCatalogPanelDeps = StudioPanelBaseDeps & {
  catalogLockedByEnv: boolean;
  serverLocalAccess: boolean;
};

export function useStudioCatalogPanel({
  libraryIndex,
  onReconcileLibrary,
  studioPane,
  t,
  catalogLockedByEnv,
  serverLocalAccess,
}: StudioCatalogPanelDeps) {
  const [catalogStudioMode, setCatalogStudioMode] =
    useState<CatalogStudioMode>(readStoredCatalogStudioMode);
  const [localSessionAccount, setLocalSessionAccount] = useState<string | null>(
    () => getSelectedAccountId(),
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
  const catalogLoadedAccountRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(REKORD_CATALOG_STUDIO_MODE, catalogStudioMode);
    } catch {
      /* ignore */
    }
  }, [catalogStudioMode]);

  useEffect(() => {
    const h = () => setLocalSessionAccount(getSelectedAccountId());
    window.addEventListener("rekord-account-session-changed", h);
    return () => window.removeEventListener("rekord-account-session-changed", h);
  }, []);

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
    catalogStudioMode,
    setCatalogStudioMode,
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
    loadCatalogPane,
    openCatalogArtist,
    addArtistCatalog,
    removeArtistCatalog,
    addAlbumCatalog,
    removeAlbumCatalog,
    filteredCatalogArtists,
  };
}
