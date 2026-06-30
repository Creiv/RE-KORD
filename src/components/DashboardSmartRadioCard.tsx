import { useCallback, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { useTrackCoverDisplay } from "../context/LibraryArtworkContext";
import { usePlayer, useTrackRowPlayer } from "../context/PlayerContext";
import {
  emitStudioPane,
  useStudioNavigation,
} from "../context/StudioNavigationContext";
import { useUserState } from "../context/UserStateContext";
import { useLibraryPlayback } from "../hooks/useLibraryPlayback";
import { useMatchMedia } from "../hooks/useMatchMedia";
import { useDashboardSmartRadioGrid } from "../hooks/useDashboardSmartRadioGrid";
import { MOBILE_LAYOUT_MQ } from "../lib/breakpoints";
import { enrichTracksFromLibrary } from "../lib/libraryNav";
import {
  buildSmartRadioCandidatePool,
  pickRandomFromPool,
  pickSmartRadioDisplayTracks,
  SMART_RADIO_MAX_DISPLAY_TRACKS,
} from "../lib/smartRadioTiles";
import { parseTrackMoods, TRACK_MOOD_COLORS } from "../lib/trackMoods";
import { versionedUrl } from "../lib/versionedUrl";
import { useI18n } from "../i18n/useI18n";
import type { AppSection, DashboardPayload, EnrichedTrack, LibraryIndex } from "../types";
import { CoverImg } from "./CoverImg";
import { SectionHeadLead } from "./SectionHeadLead";
import { TrackMoodGlyph } from "./TrackMoodGlyph";
import { UiGraphicEq, UiMusicNote, UiPlayArrow, UiRadioOutlined, UiShuffle } from "./RekordUiIcons";

type DashboardSmartRadioCardProps = {
  index: LibraryIndex;
  dashboard: DashboardPayload;
  onOpenSection: (section: AppSection) => void;
};

function SmartRadioTileArt({
  track,
}: {
  track: Pick<EnrichedTrack, "relPath" | "albumId" | "filePath" | "updatedAt">;
}) {
  const { src, fallbackSrc, version } = useTrackCoverDisplay(track);
  return (
    <CoverImg
      className="dashboard-smart-radio-tile__art"
      src={versionedUrl(src, version)}
      fallbackSrc={
        fallbackSrc ? versionedUrl(fallbackSrc, version) : undefined
      }
      alt=""
      fallbackClassName="dashboard-smart-radio-tile__art dashboard-smart-radio-tile__art--fallback"
      fallback={<UiMusicNote className="dashboard-smart-radio-tile__art-ic" />}
    />
  );
}

function SmartRadioTrackTile({
  track,
  onPlay,
}: {
  track: EnrichedTrack;
  onPlay: () => void;
}) {
  const { t } = useI18n();
  const { isPlaying } = usePlayer();
  const { isCurrent } = useTrackRowPlayer(track.relPath);
  const studioNav = useStudioNavigation();
  const showStudio = isCurrent && studioNav?.openStudioListen;
  const moods = parseTrackMoods(track.meta ?? undefined);
  const moodSummaryTitle =
    moods.length > 0
      ? t("trackMeta.moodOnTitle", {
          labels: moods.map((id) => t(`trackMeta.mood.${id}`)).join(", "),
        })
      : t("trackMeta.moodOffTitle");

  const handleAction = () => {
    if (showStudio) {
      studioNav!.openStudioListen();
      return;
    }
    onPlay();
  };

  return (
    <div
      className={`dashboard-smart-radio-tile${
        isCurrent ? " dashboard-smart-radio-tile--active" : ""
      }`}
    >
      <div className="dashboard-smart-radio-tile__media">
        <SmartRadioTileArt track={track} />
        {showStudio ? (
          <button
            type="button"
            className="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__studio"
            onClick={handleAction}
            title={t("trackRow.openStudioListenTitle")}
            aria-label={t("trackRow.openStudioListenAria")}
          >
            <UiGraphicEq animated={isPlaying} />
          </button>
        ) : (
          <button
            type="button"
            className="dashboard-smart-radio-tile__overlay dashboard-smart-radio-tile__play"
            onClick={handleAction}
            title={t("player.playTitle")}
            aria-label={t("dashboard.smartRadioPlayTrack", { title: track.title })}
          >
            <UiPlayArrow />
          </button>
        )}
      </div>
      <button
        type="button"
        className="dashboard-smart-radio-tile__meta"
        onClick={handleAction}
        title={`${track.title} · ${moodSummaryTitle}`}
      >
        <span className="dashboard-smart-radio-tile__title">{track.title}</span>
        <span
          className="track-meta-moods-cluster dashboard-smart-radio-tile__moods"
          title={moodSummaryTitle}
        >
          {moods.length === 0 ? (
            <span className="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-off">
              <TrackMoodGlyph
                mood={null}
                className="track-meta-mood-chip__glyph"
              />
            </span>
          ) : (
            moods.map((id) => (
              <span
                key={id}
                className="lib-meta-chip lib-meta-chip--ico lib-meta-chip--mood-tag"
                style={
                  { ["--mood-c"]: TRACK_MOOD_COLORS[id] } as CSSProperties
                }
                title={t(`trackMeta.mood.${id}`)}
              >
                <TrackMoodGlyph
                  mood={id}
                  className="track-meta-mood-chip__glyph"
                />
              </span>
            ))
          )}
        </span>
      </button>
    </div>
  );
}

export function DashboardSmartRadioCard({
  index,
  dashboard,
  onOpenSection,
}: DashboardSmartRadioCardProps) {
  const { t } = useI18n();
  const user = useUserState();
  const isMobile = useMatchMedia(MOBILE_LAYOUT_MQ);
  const { ref, columns, slotCount } = useDashboardSmartRadioGrid(isMobile);
  const { playGlobalRadio } = useLibraryPlayback(index.tracks);

  const candidatePool = useMemo(() => {
    const recent = enrichTracksFromLibrary(
      user.state.recent.slice(0, 2),
      index.tracks,
    );
    const favorites = enrichTracksFromLibrary(
      dashboard.favoriteTracks ?? [],
      index.tracks,
    );
    return buildSmartRadioCandidatePool(recent, favorites);
  }, [user.state.recent, dashboard.favoriteTracks, index.tracks]);

  const [sessionPickedTracks, setSessionPickedTracks] = useState<
    EnrichedTrack[] | null
  >(null);

  useLayoutEffect(() => {
    const recent = enrichTracksFromLibrary(
      user.state.recent.slice(0, 2),
      index.tracks,
    );
    const favorites = enrichTracksFromLibrary(
      dashboard.favoriteTracks ?? [],
      index.tracks,
    );
    const pool = buildSmartRadioCandidatePool(recent, favorites);
    setSessionPickedTracks(
      pickSmartRadioDisplayTracks(
        pool,
        SMART_RADIO_MAX_DISPLAY_TRACKS + 1,
        index.tracks,
      ),
    );
    // Solo al mount (navigazione in dashboard / reload pagina).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot una tantum per visita
  }, []);

  const displayTracks = useMemo(
    () =>
      (sessionPickedTracks ?? []).slice(0, Math.max(0, slotCount - 1)),
    [sessionPickedTracks, slotCount],
  );

  const goListen = useCallback(() => {
    emitStudioPane("listen");
    onOpenSection("studio");
  }, [onOpenSection]);

  const playFromPool = useCallback(
    (track: EnrichedTrack) => {
      playGlobalRadio(track, true);
      goListen();
    },
    [playGlobalRadio, goListen],
  );

  const playRandom = useCallback(() => {
    const pick =
      pickRandomFromPool(candidatePool) ?? pickRandomFromPool(index.tracks);
    if (pick) {
      playGlobalRadio(pick, true);
      goListen();
    }
  }, [candidatePool, index.tracks, playGlobalRadio, goListen]);

  const canShowGrid =
    candidatePool.length > 0 || displayTracks.length > 0 || index.tracks.length > 0;

  return (
    <section className="surface-card dashboard-session-card dashboard-smart-radio-card dashboard-page__mix">
      <div className="section-head section-head--page-toolbar">
        <SectionHeadLead
          eyebrow={t("dashboard.smartRadioEyebrow")}
          title={t("dashboard.smartRadioHeading")}
          icon={<UiRadioOutlined className="section-head__ic" />}
        />
      </div>
      {!canShowGrid ? (
        <p className="panel-empty">{t("dashboard.smartRadioEmpty")}</p>
      ) : (
        <div
          ref={ref}
          className={`dashboard-smart-radio-grid${
            isMobile ? " dashboard-smart-radio-grid--mobile" : ""
          }`}
          style={
            {
              ["--smart-radio-cols" as string]: String(columns),
            } as CSSProperties
          }
        >
          {displayTracks.map((track) => (
            <SmartRadioTrackTile
              key={track.relPath}
              track={track}
              onPlay={() => playFromPool(track)}
            />
          ))}
          <button
            type="button"
            className="dashboard-smart-radio-tile dashboard-smart-radio-tile--random"
            onClick={playRandom}
            title={t("dashboard.smartRadioRandom")}
            aria-label={t("dashboard.smartRadioRandom")}
          >
            <span
              className="dashboard-smart-radio-tile__media dashboard-smart-radio-tile__media--random"
              aria-hidden
            >
              <UiShuffle />
            </span>
            <span className="dashboard-smart-radio-tile__meta">
              <span className="dashboard-smart-radio-tile__title">
                {t("dashboard.smartRadioRandom")}
              </span>
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
