import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayer } from "../../context/PlayerContext";
import {
  useUserSettingsSlice,
  useUserShuffleSlice,
  useUserStateActions,
  useUserStateSelector,
} from "../../context/UserStateContext";
import { isFavoriteRelPath, lookupByRelPathAliases } from "../../lib/libraryNav";
import { useI18n } from "../../i18n/useI18n";
import { useLibraryPlayback } from "../../hooks/useLibraryPlayback";
import { usePlayerProgressTime } from "../../hooks/usePlayerProgressTime";
import { useOpenTrackMetaEdit, useAutoLrcRun } from "../../components/TrackMetaEditor";
import { TrackMetaEditGlyph } from "../../components/TrackMetaEditor";
import { CoverImg } from "../../components/CoverImg";
import { ExcludeShuffleIcon } from "../../components/ExcludeShuffleIcon";
import { Visualizer } from "../../components/Visualizer";
import { ListenSleepTimer } from "../../components/ListenSleepTimer";

const LazyDiscoWallVisualizer = lazy(
  () => import("../../components/DiscoWallVisualizer"),
);
import { SectionHeadLead } from "../../components/SectionHeadLead";
import {
  TrackFileMetaChip,
  TrackListRow,
  TrackRowLyricsIcon,
} from "../../components/AppSharedUi";
import {
  UiFavorite,
  UiHistory,
  UiImage,
  UiKaraoke,
  UiLyrics,
  UiMusicNote,
  UiNavList,
  UiNote,
} from "../../components/RekordUiIcons";
import { uploadAlbumCover } from "../../lib/api";
import { resolveTrackLyricsDotStatus } from "../../lib/trackLyricsDotStatus";
import { useTrackCoverDisplay } from "../../context/LibraryArtworkContext";
import { versionedUrl } from "../../lib/versionedUrl";
import { albumFolderFromTrack } from "../../lib/trackPaths";
import { enrichTracksFromLibrary, formatTrackByline } from "../../lib/libraryNav";
import { isTrackAlbumShuffleExcluded } from "../../lib/randomExclusions";
import { eligibleTracksForIntelligentRandom } from "../../lib/randomExclusions";
import { PlayCollectionButton } from "../../components/PlayCollectionButton";
import { formatDurationMs } from "../../lib/duration";
import { fmtDate, trackInfoBadges, trackReleaseYear } from "../../lib/metaFormat";
import { parseLrcLyrics, currentLrcLineIndex } from "../../lib/lrc";
import { trackLyricsIconKind } from "../../lib/trackLyricsIcon";
import type {
  AppSection,
  EnrichedTrack,
  LibraryEntityDelta,
  LibraryIndex,
} from "../../types";

interface ListenViewProps {
  index: LibraryIndex;
  onOpenSection: (section: AppSection) => void;
  onLibraryDelta?: (delta: LibraryEntityDelta, reconcile?: boolean) => void;
}

function ListenStageArt({ track }: { track: EnrichedTrack }) {
  const { src, fallbackSrc, version } = useTrackCoverDisplay(track, "full");
  return (
    <CoverImg
      priority
      className="listen-stage__art"
      src={versionedUrl(src, version)}
      fallbackSrc={
        fallbackSrc ? versionedUrl(fallbackSrc, version) : undefined
      }
      alt=""
      fallbackClassName="listen-stage__art listen-stage__art--empty"
      fallback={<UiMusicNote className="listen-stage__empty-ic" />}
    />
  );
}

export default function ListenView({
  index,
  onOpenSection,
  onLibraryDelta,
}: ListenViewProps) {
  const p = usePlayer();
  const progressTime = usePlayerProgressTime();
  const { shuffleExcludedAlbumIds, shuffleExcludedTrackRelPaths, toggleShuffleExcludedTrack } =
    useUserShuffleSlice();
  const { settings } = useUserSettingsSlice();
  const { toggleFavorite } = useUserStateActions();
  const favorites = useUserStateSelector((s) => s.favorites);
  const trackPlayCounts = useUserStateSelector((s) => s.state.trackPlayCounts);
  const recent = useUserStateSelector((s) => s.state.recent);
  const { t } = useI18n();
  const openTrackMetaEdit = useOpenTrackMetaEdit();
  const autoLrc = useAutoLrcRun();
  const exAlbums = useMemo(
    () => new Set(shuffleExcludedAlbumIds),
    [shuffleExcludedAlbumIds]
  );
  const exTracksSet = useMemo(
    () => new Set(shuffleExcludedTrackRelPaths),
    [shuffleExcludedTrackRelPaths]
  );
  const cur = p.current;
  const { playGlobalRadio, playPoolShuffle } = useLibraryPlayback(index.tracks);
  const albumShuffleExcluded = cur
    ? isTrackAlbumShuffleExcluded(cur, exAlbums)
    : false;
  const trackShuffleExcluded = cur ? exTracksSet.has(cur.relPath) : false;
  const shuffleExcluded = albumShuffleExcluded || trackShuffleExcluded;
  const playCount = cur
    ? lookupByRelPathAliases(trackPlayCounts, cur.relPath) ?? 0
    : 0;
  const curIsFavorite = cur ? isFavoriteRelPath(favorites, cur.relPath) : false;
  const listenDurationStr = cur ? formatDurationMs(cur.meta?.durationMs) : null;
  const listenBadgeLabels = {
    track: t("badges.track"),
    album: t("badges.album"),
  };
  const listenTrackYear = cur ? trackReleaseYear(cur) : null;
  const listenTrackYearTitle =
    listenTrackYear && cur?.meta?.releaseDate
      ? `${listenBadgeLabels.track} ${fmtDate(cur.meta.releaseDate)}`
      : undefined;
  const listenInfoLine = cur
    ? trackInfoBadges(cur, listenBadgeLabels)
        .filter((line) => !line.startsWith(`${listenBadgeLabels.track} `))
        .join(" · ") || ""
    : "";

  const runLibraryShuffle = () => {
    const eligible = eligibleTracksForIntelligentRandom(
      index,
      exAlbums,
      exTracksSet
    );
    playPoolShuffle(eligible, true);
  };

  const listenQueueStart = Math.max(0, p.currentIndex - 1);
  const listenQueuePreview = p.queue.slice(
    listenQueueStart,
    listenQueueStart + 6
  );

  const recentTracks = useMemo(() => {
    const curRel = cur?.relPath;
    const seeds = recent
      .filter((tr) => !curRel || tr.relPath !== curRel)
      .slice(0, 6);
    return enrichTracksFromLibrary(seeds, index.tracks);
  }, [recent, cur?.relPath, index.tracks]);

  const [listenRecentPanel, setListenRecentPanel] = useState<
    "recent" | "lyrics"
  >("recent");

  const currentLyricsRaw = String(cur?.meta?.lyrics || "").trim();
  const parsedLrc = useMemo(
    () => parseLrcLyrics(currentLyricsRaw),
    [currentLyricsRaw]
  );
  const currentLrcIdx = useMemo(
    () => currentLrcLineIndex(parsedLrc, progressTime),
    [parsedLrc, progressTime]
  );
  const hasLyrics = currentLyricsRaw.length > 0;
  const hasLrcLyrics = parsedLrc.length > 0;

  const [karaokeOpen, setKaraokeOpen] = useState(false);

  const runListenAutoLrc = () => {
    if (!cur || autoLrc.busy) return;
    void autoLrc.runForTrack(cur, (delta) => {
      if (delta) onLibraryDelta?.(delta, false);
    });
  };

  const lyricsDot = resolveTrackLyricsDotStatus({
    meta: cur?.meta,
    fetchBusy: autoLrc.busy && autoLrc.relPath === cur?.relPath,
    ephemeralAutoStatus:
      autoLrc.relPath === cur?.relPath ? autoLrc.status : "idle",
  });
  const lyricsAutoMsg =
    autoLrc.relPath === cur?.relPath ? autoLrc.msg : null;
  const lyricsDotLabel =
    lyricsDot === "busy"
      ? t("trackMeta.fetchLrcBusy")
      : lyricsDot === "error"
        ? t("trackMeta.lyricsAutoStatus.error")
        : lyricsDot === "okLrc"
          ? t("trackRow.lyricsLrc")
          : lyricsDot === "okPlain"
            ? t("trackRow.lyricsPlain")
            : lyricsDot === "missing"
              ? t("trackMeta.lyricsAutoStatus.missing")
              : t("trackRow.lyricsMissing");

  const trackChangeTransitionsOn =
    settings.audioCrossfadeSec > 0;

  const lrcScrollRef = useRef<HTMLDivElement>(null);
  const lrcCurrentLineRef = useRef<HTMLButtonElement | null>(null);
  const vizScrollRef = useRef<HTMLDivElement | null>(null);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const [coverUploadBusy, setCoverUploadBusy] = useState(false);
  const [coverUploadErr, setCoverUploadErr] = useState<string | null>(null);

  const currentAlbumPath = cur ? albumFolderFromTrack(cur) : "";

  const onCoverFilePicked = (file: File | null) => {
    if (!file || !currentAlbumPath || coverUploadBusy) return;
    setCoverUploadBusy(true);
    setCoverUploadErr(null);
    uploadAlbumCover(currentAlbumPath, file)
      .then((delta) => {
        onLibraryDelta?.(delta, false);
      })
      .catch((e) => {
        setCoverUploadErr(String(e?.message || e));
      })
      .finally(() => setCoverUploadBusy(false));
  };

  useLayoutEffect(() => {
    setListenRecentPanel(hasLyrics ? "lyrics" : "recent");
  }, [hasLyrics, cur?.relPath]);

  useLayoutEffect(() => {
    if (!hasLrcLyrics || listenRecentPanel !== "lyrics") return;
    const wrap = lrcScrollRef.current;
    if (!wrap) return;
    if (currentLrcIdx < 0) {
      wrap.scrollTop = 0;
      return;
    }
    const line = lrcCurrentLineRef.current;
    if (!line) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lineTop = line.offsetTop;
    const lineH = line.offsetHeight;
    const half = wrap.clientHeight / 2;
    const target = lineTop + lineH / 2 - half;
    const max = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    const next = Math.max(0, Math.min(target, max));
    wrap.scrollTo({
      top: next,
      behavior:
        reduce || !trackChangeTransitionsOn ? "auto" : "smooth",
    });
  }, [
    currentLrcIdx,
    listenRecentPanel,
    hasLrcLyrics,
    parsedLrc.length,
    trackChangeTransitionsOn,
  ]);

  useLayoutEffect(() => {
    if (!cur?.relPath) return;
    if (!trackChangeTransitionsOn) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const raf = window.requestAnimationFrame(() => {
      vizScrollRef.current?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [cur?.relPath, trackChangeTransitionsOn]);

  return (
    <div className="view-page view-page--listen">
      <div className="listen-page">
        <section className="listen-page__stage listen-stage">
          <div className="listen-stage__primary">
          <div className="listen-stage__meta">
            <div className="listen-stage__head">
              {p.current?.relPath ? (
                <button
                  type="button"
                  className={`listen-stage__art-btn${
                    coverUploadBusy ? " is-busy" : ""
                  }`}
                  onClick={() => coverFileInputRef.current?.click()}
                  disabled={coverUploadBusy || !currentAlbumPath}
                  title={t("library.coverUploadTitle")}
                  aria-label={t("library.coverUploadAria")}
                >
                  <ListenStageArt track={p.current} />
                  <span className="listen-stage__cover-edit-badge" aria-hidden>
                    <UiImage />
                  </span>
                  {coverUploadErr ? (
                    <span className="listen-stage__cover-edit-err">
                      {t("library.coverUploadErr")}
                    </span>
                  ) : null}
                </button>
              ) : (
                <div
                  className="listen-stage__art listen-stage__art--empty"
                  aria-hidden
                >
                  <UiMusicNote className="listen-stage__empty-ic" />
                </div>
              )}
              <input
                ref={coverFileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  onCoverFilePicked(file);
                }}
              />
              <div className="listen-stage__text">
                <div className="listen-stage__text-lead">
                  <div className="listen-stage__eyebrow-row">
                  <p className="eyebrow">{t("listen.currentEyebrow")}</p>
                  {cur ? (
                    <>
                    <div className="listen-stage__eyebrow-actions">
                      <button
                        type="button"
                        className={`listen-stage__fav ${
                          curIsFavorite ? "is-on" : ""
                        }`}
                        onClick={() => toggleFavorite(cur.relPath)}
                        title={t("trackRow.favTitle")}
                        aria-pressed={curIsFavorite}
                        aria-label={t("trackRow.favAria")}
                      >
                        <span className="listen-stage__fav-ic" aria-hidden>
                          <UiFavorite />
                        </span>
                      </button>
                      <button
                        type="button"
                        className="track-row__ic track-row__ic--meta"
                        onClick={() => openTrackMetaEdit(cur)}
                        title={t("trackRow.editMetaTitle")}
                        aria-label={t("trackRow.editMetaAria")}
                      >
                        <span className="track-row__ic-glyph track-row__ic-glyph--svg">
                          <TrackMetaEditGlyph />
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`track-row__ic track-row__ic--exclude ${
                          shuffleExcluded ? "is-on" : ""
                        }`}
                        disabled={albumShuffleExcluded}
                        title={
                          albumShuffleExcluded
                            ? t("trackRow.excludeLockedByAlbumTitle")
                            : shuffleExcluded
                              ? t("trackRow.unblockShuffle")
                              : t("trackRow.blockShuffle")
                        }
                        onClick={() => {
                          if (albumShuffleExcluded) return;
                          toggleShuffleExcludedTrack(cur.relPath);
                        }}
                        aria-pressed={shuffleExcluded}
                        aria-label={
                          albumShuffleExcluded
                            ? t("trackRow.excludeLockedByAlbumAria")
                            : shuffleExcluded
                              ? t("trackRow.unblockShuffle")
                              : t("trackRow.blockShuffle")
                        }
                      >
                        <span
                          className="track-row__ic-glyph track-row__ic-glyph--svg"
                          aria-hidden
                        >
                          <ExcludeShuffleIcon />
                        </span>
                      </button>
                    </div>
                    {listenTrackYear ? (
                      <span
                        className="listen-stage__track-year"
                        title={listenTrackYearTitle}
                      >
                        {listenTrackYear}
                      </span>
                    ) : null}
                    </>
                  ) : null}
                </div>
                <h1 className="listen-stage__title">
                  {p.current?.title || t("listen.noTrack")}
                </h1>
                {!cur ? (
                  <p className="listen-stage__sub">
                    {t("listen.openLibraryHint")}
                  </p>
                ) : null}
                </div>
                {cur ? (
                  <div className="listen-stage__meta-full">
                <p className="listen-stage__sub listen-stage__sub--with-stats">
                  <span className="listen-stage__sub-lead">
                    {formatTrackByline(cur)}
                    {trackLyricsIconKind(cur.meta) !== "hidden" ? (
                      <>
                        <span className="track-row__meta-sep" aria-hidden>
                          {" "}
                          ·{" "}
                        </span>
                        <TrackRowLyricsIcon
                          meta={cur.meta}
                          className="listen-stage__lyrics-inline"
                        />
                      </>
                    ) : null}
                    {listenDurationStr ? ` · ${listenDurationStr}` : ""}
                  </span>
                  <span className="listen-stage__sub-sep" aria-hidden>
                    {" "}
                    ·{" "}
                  </span>
                  <span
                    className="track-row__plays listen-stage__sub-plays"
                    aria-label={t("trackRow.playCount", { n: playCount })}
                  >
                    ({playCount})
                  </span>
                  <TrackFileMetaChip meta={cur.meta} />
                </p>
                {listenInfoLine ? (
                <div className="listen-stage__detail">
                  <p className="track-row__badges listen-stage__meta-badges">
                    {listenInfoLine}
                  </p>
                </div>
                ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          </div>
          <div className="listen-stage__viz" ref={vizScrollRef}>
            {settings.vizMode === "discowall" ? (
              <Suspense
                fallback={
                  <div
                    className="viz-wrap is-discowall is-discowall--dormant"
                    aria-hidden
                  />
                }
              >
                <LazyDiscoWallVisualizer />
              </Suspense>
            ) : (
              <Visualizer mode={settings.vizMode} />
            )}
          </div>
          <ListenSleepTimer />
        </section>

        <div className="listen-page__panels listen-dashboard-row">
          <section className="surface-card listen-queue-panel">
            <div className="section-head section-head--page-toolbar library-genre-tracklist-headrow">
              <SectionHeadLead
                eyebrow={t("listen.queueEyebrow")}
                title={t("listen.queueHeading")}
                icon={<UiNavList className="section-head__ic" />}
              />
              <button
                type="button"
                className="text-btn"
                onClick={() => onOpenSection("queue")}
              >
                {t("listen.manageQueue")}
              </button>
            </div>
            <div className="listen-queue-panel__body">
              {p.queue.length === 0 ? (
                <div className="panel-empty panel-empty--actions">
                  <p>{t("listen.queueEmpty")}</p>
                  <PlayCollectionButton
                    label={t("playback.playLibrary")}
                    onClick={runLibraryShuffle}
                  />
                </div>
              ) : (
                <div className="list-stack listen-queue-panel__list">
                  {listenQueuePreview.map((track, i) => {
                    const queueIdx = listenQueueStart + i;
                    return (
                      <TrackListRow
                        key={`${track.relPath}-${queueIdx}`}
                        track={track}
                        autoFocusActive={false}
                        active={queueIdx === p.currentIndex}
                        onPlay={() => p.playTrack(track, p.queue, queueIdx)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="surface-card listen-recent-panel">
            <div className="section-head section-head--page-toolbar listen-recent-panel__head">
              <div className="section-head__lead listen-recent-panel__lead">
                <span className="section-head__icon-wrap" aria-hidden>
                  {listenRecentPanel === "recent" ? (
                    <UiHistory className="section-head__ic" />
                  ) : (
                    <UiNote className="section-head__ic" />
                  )}
                </span>
                <div className="section-head__text">
                  <p className="eyebrow">
                    {listenRecentPanel === "recent"
                      ? t("listen.recentEyebrow")
                      : t("listen.recentLyricsEyebrow")}
                  </p>
                  <div
                    className="section-nav-tabs listen-recent-panel__nav"
                    role="tablist"
                    aria-label={t("listen.recentPanelTabsAria")}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={listenRecentPanel === "recent"}
                      className={
                        listenRecentPanel === "recent"
                          ? "section-nav-tab is-on"
                          : "section-nav-tab"
                      }
                      onClick={() => setListenRecentPanel("recent")}
                    >
                      {t("listen.recentTabRecent")}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={listenRecentPanel === "lyrics"}
                      className={
                        listenRecentPanel === "lyrics"
                          ? "section-nav-tab is-on"
                          : "section-nav-tab"
                      }
                      disabled={!cur}
                      onClick={() => {
                        if (cur) setListenRecentPanel("lyrics");
                      }}
                    >
                      {t("listen.recentLyricsPlainTitle")}
                    </button>
                  </div>
                </div>
              </div>
              {listenRecentPanel === "recent" ? (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => onOpenSection("recent")}
                >
                  {t("listen.recentSeeAll")}
                </button>
              ) : (
                <div className="listen-recent-panel__lyrics-tools">
                  {hasLrcLyrics ? (
                    <button
                      type="button"
                      className="listen-recent-panel__karaoke-btn"
                      title={t("listen.karaokeOpenTitle")}
                      aria-label={t("listen.karaokeOpenTitle")}
                      onClick={() => setKaraokeOpen(true)}
                    >
                      <UiKaraoke className="listen-recent-panel__karaoke-ic" />
                      <span className="listen-recent-panel__karaoke-label">
                        KARAOKE
                      </span>
                    </button>
                  ) : null}
                  <span
                    className="listen-recent-panel__lrc-state is-on"
                    aria-label={lyricsDotLabel}
                    title={lyricsDotLabel}
                  >
                    <span
                      className={`meta-edit-lyrics-status-dot meta-edit-lyrics-status-dot--${lyricsDot}`}
                      aria-hidden
                    />
                    LRC
                  </span>
                </div>
              )}
            </div>
            <div className="listen-recent-panel__body">
              {listenRecentPanel === "recent" ? (
                recentTracks.length ? (
                  <div className="list-stack listen-recent-panel__list">
                    {recentTracks.map((track) => (
                      <TrackListRow
                        key={track.relPath}
                        track={track}
                        autoFocusActive={false}
                        onPlay={() => playGlobalRadio(track, true)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="panel-empty">{t("listen.recentEmpty")}</p>
                )
              ) : hasLyrics ? (
                <div
                  className="listen-recent-lyrics"
                  role="region"
                  aria-live="polite"
                  aria-label={
                    hasLrcLyrics
                      ? t("listen.recentLyricsTitle")
                      : t("listen.recentLyricsPlainTitle")
                  }
                >
                  {hasLrcLyrics ? (
                    <div
                      ref={lrcScrollRef}
                      className="listen-recent-lyrics__lrc"
                    >
                      {parsedLrc.map((row, idx) => (
                        <button
                          key={`${row.atSec}-${idx}`}
                          type="button"
                          ref={
                            idx === currentLrcIdx
                              ? lrcCurrentLineRef
                              : undefined
                          }
                          className={
                            idx === currentLrcIdx
                              ? "listen-recent-lyrics__line listen-recent-lyrics__line--seek is-current"
                              : "listen-recent-lyrics__line listen-recent-lyrics__line--seek"
                          }
                          title={t("listen.lyricsSeekTitle")}
                          onClick={() => p.seek(row.atSec)}
                        >
                          {row.text || "…"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <pre className="listen-recent-lyrics__plain">
                      {currentLyricsRaw}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="panel-empty panel-empty--actions listen-recent-lyrics__empty">
                  <span
                    className="listen-recent-lyrics__empty-ic"
                    aria-hidden
                  >
                    <UiLyrics />
                  </span>
                  <p className="subtle sm">
                    {lyricsDot === "missing"
                      ? t("trackMeta.lyricsAutoStatus.missing")
                      : t("listen.recentLyricsNone")}
                  </p>
                  {lyricsAutoMsg ? (
                    <p className="subtle sm warnline">{lyricsAutoMsg}</p>
                  ) : null}
                  {cur ? (
                    <div className="listen-recent-lyrics__empty-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={autoLrc.busy && autoLrc.relPath === cur.relPath}
                        onClick={() =>
                          openTrackMetaEdit(cur, { openLyrics: true })
                        }
                      >
                        {t("trackMeta.lyricsEditBtn")}
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={autoLrc.busy && autoLrc.relPath === cur?.relPath}
                        onClick={runListenAutoLrc}
                      >
                        {autoLrc.busy && autoLrc.relPath === cur?.relPath
                          ? t("trackMeta.fetchLrcBusy")
                          : t("trackMeta.fetchLrc")}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            {karaokeOpen ? (
              <Visualizer
                mode="karaoke"
                fullscreenOnly
                onExitFullscreen={() => setKaraokeOpen(false)}
              />
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
