import type { ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { useLibraryPlayback } from "../hooks/useLibraryPlayback";
import { PlayCollectionButton } from "../components/PlayCollectionButton";
import { SectionHeadLead } from "../components/SectionHeadLead";
import { TrackListRow } from "../components/AppSharedUi";
import type { EnrichedTrack } from "../types";

function TrackCollectionView({
  title,
  eyebrow,
  tracks,
  libraryTracks,
  collectionMode = "shuffle",
  leadIcon,
}: {
  title: string;
  eyebrow: string;
  tracks: EnrichedTrack[];
  libraryTracks?: readonly EnrichedTrack[];
  /** `shuffle`: collezione (preferiti); `radio`: radio globale (recenti) */
  collectionMode?: "shuffle" | "radio";
  leadIcon?: ReactNode;
}) {
  const { t } = useI18n();
  const { playGlobalRadio, playCollectionShuffle, playPoolShuffle } =
    useLibraryPlayback(libraryTracks);

  const playAllLabel =
    collectionMode === "radio"
      ? t("playback.playRecent")
      : t("collection.playFavorites");

  const onTrackPlay = (track: EnrichedTrack) => {
    if (collectionMode === "radio") {
      playGlobalRadio(track, true);
      return;
    }
    playCollectionShuffle(track, tracks, true);
  };

  return (
    <div className="view-page view-page--split collection-page">
      <header className="view-page__toolbar-band">
        <section className="surface-card surface-card--toolbar-only">
          <div className="section-head section-head--page-toolbar">
            <SectionHeadLead eyebrow={eyebrow} title={title} icon={leadIcon} />
            {tracks.length > 0 ? (
              <PlayCollectionButton
                label={playAllLabel}
                onClick={() => playPoolShuffle(tracks, true)}
              />
            ) : null}
          </div>
        </section>
      </header>
      <section className="surface-card collection-page__list view-page__body">
        {tracks.length === 0 ? (
          <p className="panel-empty">{t("collection.empty")}</p>
        ) : (
          <div className="list-stack">
            {tracks.map((track, index) => (
              <TrackListRow
                key={`${track.relPath}-${index}`}
                track={track}
                onPlay={() => onTrackPlay(track)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


export default TrackCollectionView;
