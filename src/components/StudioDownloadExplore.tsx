import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchYoutubeExploreSearch,
  newStudioDownloadId,
  runYtdlpDownload,
  streamYoutubeReleasesList,
  type StudioDownloadKind,
  type YoutubeExploreResult,
  type YoutubeReleaseEntry,
} from "../lib/api";
import type { DownloadItemSummary } from "../lib/downloadLogSummary";
import { ytdlpLogDetailForUser } from "../lib/ytdlpLogFilter";
import type { useI18n } from "../i18n/useI18n";
import type { LibraryReconcileOptions } from "../lib/libraryReconcile";
import { UiAlbumIcon, UiMusicNote, UiPerson } from "./RekordUiIcons";
import { StudioDownloadDisclaimer } from "./StudioDownloadDisclaimer";

type TFn = ReturnType<typeof useI18n>["t"];

type Props = {
  t: TFn;
  dlPath: string;
  /** Cartella effettiva per yt-dlp (album → sottocartella sotto artista, come in classico). */
  resolveOutputDir: (dlPath: string, item: YoutubeExploreResult) => string;
  downloadKindForItem: (item: YoutubeExploreResult) => StudioDownloadKind;
  /** I singoli seguono il vincolo classico: destinazione Artista/Album. */
  singleBlockedArtistFolder: boolean;
  hasValidDownloadDest: boolean;
  dlBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onTrackProgress: (p: { current: number; total: number } | null) => void;
  onLog: (updater: (prev: string) => string) => void;
  onReconcileLibrary: (opts?: LibraryReconcileOptions) => void | Promise<void>;
  onPrepareDownload: (item: YoutubeExploreResult) => Promise<boolean>;
  downloadSummaryLine: (r: DownloadItemSummary) => string;
  onDownloadIdChange?: (downloadId: string | null) => void;
};

function exploreItemKey(item: YoutubeExploreResult) {
  return `${item.type}-${item.id}`;
}

function releaseEntryToAlbumItem(
  entry: YoutubeReleaseEntry,
  artist: YoutubeExploreResult,
): YoutubeExploreResult {
  return {
    id: entry.id,
    type: "album",
    title: entry.title,
    subtitle: artist.title,
    url: entry.url,
  };
}

export function StudioDownloadExplore({
  t,
  dlPath,
  resolveOutputDir,
  downloadKindForItem,
  singleBlockedArtistFolder,
  hasValidDownloadDest,
  dlBusy,
  onBusyChange,
  onTrackProgress,
  onLog,
  onReconcileLibrary,
  onPrepareDownload,
  downloadSummaryLine,
  onDownloadIdChange,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [results, setResults] = useState<YoutubeExploreResult[]>([]);
  const [preparingKey, setPreparingKey] = useState<string | null>(null);
  const [expandedArtistKey, setExpandedArtistKey] = useState<string | null>(
    null,
  );
  const [artistAlbums, setArtistAlbums] = useState<
    Record<string, YoutubeReleaseEntry[]>
  >({});
  const [artistLoadBusy, setArtistLoadBusy] = useState<string | null>(null);
  const [artistLoadErr, setArtistLoadErr] = useState<Record<string, string>>(
    {},
  );
  const runLatch = useRef(false);
  const searchGen = useRef(0);
  const artistLoadGen = useRef(0);
  const artistAlbumsRef = useRef(artistAlbums);
  artistAlbumsRef.current = artistAlbums;

  const runSearch = useCallback((raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchErr(null);
      return;
    }
    const gen = ++searchGen.current;
    setSearchErr(null);
    setSearchBusy(true);
    fetchYoutubeExploreSearch(q)
      .then((d) => {
        if (gen !== searchGen.current) return;
        setResults(d.results);
        setExpandedArtistKey(null);
        setArtistAlbums({});
        setArtistLoadErr({});
      })
      .catch((e: unknown) => {
        if (gen !== searchGen.current) return;
        setResults([]);
        setSearchErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (gen === searchGen.current) setSearchBusy(false);
      });
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchErr(null);
      return;
    }
    const timer = window.setTimeout(() => runSearch(q), 420);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  const { artists, albums, songs } = useMemo(() => {
    const ar: YoutubeExploreResult[] = [];
    const a: YoutubeExploreResult[] = [];
    const s: YoutubeExploreResult[] = [];
    for (const item of results) {
      if (item.type === "artist") ar.push(item);
      else if (item.type === "album") a.push(item);
      else if (item.type === "song") s.push(item);
    }
    return { artists: ar, albums: a, songs: s };
  }, [results]);

  const loadArtistAlbums = useCallback(async (artist: YoutubeExploreResult) => {
    const key = exploreItemKey(artist);
    if (artistAlbumsRef.current[key]?.length) return;
    const gen = ++artistLoadGen.current;
      setArtistLoadBusy(key);
      setArtistLoadErr((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      const entries: YoutubeReleaseEntry[] = [];
      try {
        await streamYoutubeReleasesList(
          artist.url,
          {
            onMeta: () => {},
            onEntry: (entry) => {
              if (gen !== artistLoadGen.current) return;
              entries.push(entry);
            },
            onDone: () => {},
          },
          { enrichCounts: false },
        );
        if (gen !== artistLoadGen.current) return;
        setArtistAlbums((prev) => ({ ...prev, [key]: entries }));
        if (!entries.length) {
          setArtistLoadErr((prev) => ({
            ...prev,
            [key]: t("tools.exploreArtistEmpty"),
          }));
        }
      } catch (e) {
        if (gen !== artistLoadGen.current) return;
        setArtistLoadErr((prev) => ({
          ...prev,
          [key]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        if (gen === artistLoadGen.current) setArtistLoadBusy(null);
      }
  }, [t]);

  const toggleArtist = useCallback(
    (artist: YoutubeExploreResult) => {
      const key = exploreItemKey(artist);
      if (expandedArtistKey === key) {
        setExpandedArtistKey(null);
        return;
      }
      setExpandedArtistKey(key);
      void loadArtistAlbums(artist);
    },
    [expandedArtistKey, loadArtistAlbums],
  );

  const downloadItem = useCallback(
    async (item: YoutubeExploreResult) => {
      const itemKey = exploreItemKey(item);
      setPreparingKey(itemKey);
      let proceed: boolean;
      try {
        if (!hasValidDownloadDest) {
          onLog((x) => x + t("tools.dlPickFolder"));
          return;
        }
        proceed = await onPrepareDownload(item);
      } finally {
        setPreparingKey((prev) => (prev === itemKey ? null : prev));
      }
      if (!proceed) return;
      if (runLatch.current || dlBusy) return;
      runLatch.current = true;
      onBusyChange(true);
      onTrackProgress(null);
      const outputDir = resolveOutputDir(dlPath, item);
      const dlId = newStudioDownloadId();
      onDownloadIdChange?.(dlId);
      onLog(
        (x) =>
          x +
          t("tools.exploreDlStart", { title: item.title, path: outputDir }) +
          "\n",
      );
      try {
        const r = await runYtdlpDownload(
          item.url,
          outputDir,
          (p) => onTrackProgress({ current: p.current, total: p.total }),
          { downloadId: dlId, downloadKind: downloadKindForItem(item) },
        );
        if (r.progress && r.progress.total > 0) {
          onTrackProgress({
            current: r.progress.current,
            total: r.progress.total,
          });
        }
        const detail = ytdlpLogDetailForUser(r);
        onLog((x) => {
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
        await onReconcileLibrary({ mode: "now" });
      } catch (e) {
        onLog(
          (x) =>
            x +
            t("tools.dlFail", {
              e: String((e as Error)?.message || e),
            }),
        );
      } finally {
        onDownloadIdChange?.(null);
        onBusyChange(false);
        runLatch.current = false;
      }
    },
    [
      hasValidDownloadDest,
      dlBusy,
      dlPath,
      resolveOutputDir,
      downloadKindForItem,
      onBusyChange,
      onTrackProgress,
      onLog,
      onReconcileLibrary,
      onPrepareDownload,
      downloadSummaryLine,
      onDownloadIdChange,
      t,
    ],
  );

  const renderDownloadRow = (item: YoutubeExploreResult) => {
    const key = exploreItemKey(item);
    const isPreparing = preparingKey === key;
    const isAlbum = item.type === "album";
    const blockedSingle = !isAlbum && singleBlockedArtistFolder;
    const rowBusy = dlBusy || preparingKey != null || blockedSingle;

    return (
      <li key={key}>
        <button
          type="button"
          className={`tools-dl-explore__item${
            isPreparing ? " tools-dl-explore__item--preparing" : ""
          }`}
          disabled={rowBusy}
          aria-busy={isPreparing}
          aria-label={isPreparing ? t("tools.explorePreparingConfirm") : undefined}
          onClick={() => void downloadItem(item)}
        >
          <span
            className={`tools-dl-explore__thumb tools-dl-explore__thumb--fallback${
              isAlbum ? " tools-dl-explore__thumb--album" : ""
            }`}
            aria-hidden
          >
            {isAlbum ? (
              <UiAlbumIcon className="tools-dl-explore__thumb-fallback-ic" />
            ) : (
              <UiMusicNote className="tools-dl-explore__thumb-fallback-ic" />
            )}
          </span>
          <span className="tools-dl-explore__item-body">
            <span className="tools-dl-explore__item-title">{item.title}</span>
            {item.subtitle ? (
              <span className="tools-dl-explore__item-meta">{item.subtitle}</span>
            ) : null}
          </span>
          {isPreparing ? (
            <span className="tools-dl-explore__sk-overlay" aria-hidden>
              <span className="tools-dl-explore__thumb tools-dl-explore__thumb--sk" />
              <span className="tools-dl-explore__item-body tools-dl-explore__item-body--sk">
                <span className="tools-dl-explore__skeleton-bar" />
                {item.subtitle ? (
                  <span className="tools-dl-explore__skeleton-bar tools-dl-explore__skeleton-bar--sub" />
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const renderArtistRow = (artist: YoutubeExploreResult) => {
    const key = exploreItemKey(artist);
    const expanded = expandedArtistKey === key;
    const loading = artistLoadBusy === key;
    const albumsForArtist = artistAlbums[key] ?? [];
    const err = artistLoadErr[key];

    return (
      <li key={key} className="tools-dl-explore__artist">
        <button
          type="button"
          className={`tools-dl-explore__item tools-dl-explore__item--artist${
            expanded ? " is-expanded" : ""
          }`}
          disabled={dlBusy || preparingKey != null}
          aria-expanded={expanded}
          onClick={() => toggleArtist(artist)}
        >
          <span
            className="tools-dl-explore__thumb tools-dl-explore__thumb--fallback tools-dl-explore__thumb--artist"
            aria-hidden
          >
            <UiPerson className="tools-dl-explore__thumb-fallback-ic" />
          </span>
          <span className="tools-dl-explore__item-body">
            <span className="tools-dl-explore__item-title">{artist.title}</span>
            {artist.subtitle ? (
              <span className="tools-dl-explore__item-meta">{artist.subtitle}</span>
            ) : null}
          </span>
        </button>
        {expanded ? (
          <div className="tools-dl-explore__artist-panel">
            {loading ? (
              <p className="subtle sm" role="status">
                {t("tools.exploreArtistLoading")}
              </p>
            ) : null}
            {err ? <p className="subtle sm warnline">{err}</p> : null}
            {albumsForArtist.length > 0 ? (
              <>
                <p className="tools-dl-explore__artist-panel-title subtle sm">
                  {t("tools.exploreArtistAlbums")}
                </p>
                <ul className="tools-dl-explore__list tools-dl-explore__list--nested">
                  {albumsForArtist.map((entry) =>
                    renderDownloadRow(releaseEntryToAlbumItem(entry, artist)),
                  )}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="tools-dl-explore">
      <p className="subtle sm tools-dl-explore__lead">{t("tools.exploreLead")}</p>
      <StudioDownloadDisclaimer t={t} />

      <input
        type="search"
        className="w-full tools-dl-explore__search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("tools.exploreSearchPh")}
        aria-label={t("tools.exploreSearchAria")}
        autoComplete="off"
      />

      {searchBusy ? (
        <p className="subtle sm" role="status">
          {t("tools.searching")}
        </p>
      ) : null}
      {searchErr ? <p className="subtle sm warnline">{searchErr}</p> : null}

      {query.trim().length >= 2 &&
      !searchBusy &&
      !searchErr &&
      artists.length === 0 &&
      albums.length === 0 &&
      songs.length === 0 ? (
        <p className="subtle sm">{t("tools.exploreEmpty")}</p>
      ) : null}

      {artists.length > 0 ? (
        <section
          className="tools-dl-explore__group"
          aria-label={t("tools.exploreArtistsSection")}
        >
          <h5 className="tools-dl-explore__group-title">
            {t("tools.exploreArtistsSection")}
          </h5>
          <ul className="tools-dl-explore__list">{artists.map(renderArtistRow)}</ul>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section className="tools-dl-explore__group" aria-label={t("tools.exploreAlbumsSection")}>
          <h5 className="tools-dl-explore__group-title">
            {t("tools.exploreAlbumsSection")}
          </h5>
          <ul className="tools-dl-explore__list">{albums.map(renderDownloadRow)}</ul>
        </section>
      ) : null}

      {songs.length > 0 ? (
        <section className="tools-dl-explore__group" aria-label={t("tools.exploreSongsSection")}>
          <h5 className="tools-dl-explore__group-title">
            {t("tools.exploreSongsSection")}
          </h5>
          <ul className="tools-dl-explore__list">{songs.map(renderDownloadRow)}</ul>
        </section>
      ) : null}

      {dlBusy ? (
        <p className="subtle sm" role="status">
          {t("tools.exploreDownloading")}
        </p>
      ) : null}
    </div>
  );
}
