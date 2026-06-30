import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { usePlayer } from "../context/PlayerContext";
import { useUserState } from "../context/UserStateContext";
import { useI18n } from "../i18n/useI18n";
import { trackBelongsToGenreKey, parseTrackGenres } from "../lib/genres";
import {
  isTrackShuffleExcluded,
} from "../lib/randomExclusions";
import { buildSmartRandomQueue, splitQueueWindow } from "../lib/smartShuffle";
import {
  TRACK_MOOD_COLORS,
  TRACK_MOOD_IDS,
  parseTrackMoods,
  type TrackMoodId,
} from "../lib/trackMoods";
import type { AppSection, LibraryIndex, LibraryTrackIndex } from "../types";
import { SectionHeadLead } from "./SectionHeadLead";
import { TrackMoodGlyph } from "./TrackMoodGlyph";
import { UiMusicNote } from "./RekordUiIcons";

const DASHBOARD_MIX_TOP_GENRES = 14;

function filterTracksByMoodRules(
  tracks: readonly LibraryTrackIndex[],
  moodIds: TrackMoodId[],
  moodMatchMode: "any" | "all"
): LibraryTrackIndex[] {
  if (moodIds.length === 0) return [...tracks];
  const need = new Set(moodIds);
  return tracks.filter((tr) => {
    const moods = parseTrackMoods(tr.meta ?? undefined);
    if (moodMatchMode === "any") {
      return moods.some((mid) => need.has(mid));
    }
    return moodIds.every((mid) => moods.includes(mid));
  });
}

type DashboardMixCardProps = {
  index: LibraryIndex;
  onOpenSection: (section: AppSection) => void;
};

export function DashboardMixCard({
  index,
  onOpenSection,
}: DashboardMixCardProps) {
  const { t, sortLocale } = useI18n();
  const p = usePlayer();
  const user = useUserState();
  const [genreKey, setGenreKey] = useState<string | null>(null);
  const [moodFilterIds, setMoodFilterIds] = useState<TrackMoodId[]>([]);
  const [moodMatchMode, setMoodMatchMode] = useState<"any" | "all">("any");

  const exAlbums = useMemo(
    () => new Set(user.state.shuffleExcludedAlbumIds),
    [user.state.shuffleExcludedAlbumIds]
  );
  const exTracks = useMemo(
    () => new Set(user.state.shuffleExcludedTrackRelPaths),
    [user.state.shuffleExcludedTrackRelPaths]
  );

  const shufflePool = useMemo(
    () =>
      index.tracks.filter(
        (tr) => !isTrackShuffleExcluded(tr, exTracks, exAlbums)
      ),
    [index.tracks, exTracks, exAlbums]
  );

  const genreIndex = useMemo(() => {
    const byLower = new Map<string, { label: string; count: number }>();
    for (const tr of shufflePool) {
      const toks = parseTrackGenres(tr.meta?.genre);
      if (toks.length === 0) continue;
      for (const raw of toks) {
        const low = raw.toLowerCase();
        const prev = byLower.get(low);
        if (!prev) byLower.set(low, { label: raw, count: 1 });
        else prev.count += 1;
      }
    }
    const list = Array.from(byLower.entries())
      .map(([key, v]) => ({ key, label: v.label, count: v.count }))
      .sort((a, b) =>
        a.label.localeCompare(b.label, sortLocale, { numeric: true })
      );
    return { list };
  }, [shufflePool, sortLocale]);

  const topGenresByCount = useMemo(
    () =>
      [...genreIndex.list]
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.label.localeCompare(b.label, sortLocale, { numeric: true }),
        )
        .slice(0, DASHBOARD_MIX_TOP_GENRES),
    [genreIndex.list, sortLocale],
  );

  const moodOccurrenceCountById = useMemo(() => {
    const m = new Map<TrackMoodId, number>();
    for (const id of TRACK_MOOD_IDS) m.set(id, 0);
    for (const tr of shufflePool) {
      for (const mid of parseTrackMoods(tr.meta ?? undefined)) {
        m.set(mid, (m.get(mid) ?? 0) + 1);
      }
    }
    return m;
  }, [shufflePool]);

  const hasFilter = genreKey != null || moodFilterIds.length > 0;

  const shuffleEligible = useMemo(() => {
    if (!hasFilter) return [] as LibraryTrackIndex[];
    let base: readonly LibraryTrackIndex[] = shufflePool;
    if (genreKey != null) {
      base = base.filter((tr) =>
        trackBelongsToGenreKey(tr.meta?.genre, genreKey)
      );
    }
    return filterTracksByMoodRules(base, moodFilterIds, moodMatchMode);
  }, [genreKey, hasFilter, shufflePool, moodFilterIds, moodMatchMode]);

  const playMixShuffle = useCallback(() => {
    if (!shuffleEligible.length) return;
    const recentRelPaths = new Set(
      user.state.recent.slice(0, 48).map((tr) => tr.relPath)
    );
    const shuffled = buildSmartRandomQueue(shuffleEligible, {
      currentRelPath: p.current?.relPath,
      currentArtist: p.current?.artist,
      recentRelPaths,
    });
    const { window, remainder } = splitQueueWindow(shuffled);
    if (!window[0]) return;
    p.playTrack(window[0], window, 0, {
      preserveQueueOrder: true,
      refillRemainder: remainder,
    });
  }, [shuffleEligible, user.state.recent, p]);

  return (
    <section className="surface-card dashboard-session-card dashboard-mix-card dashboard-page__mix">
      <div className="section-head section-head--page-toolbar">
        <SectionHeadLead
          eyebrow={t("dashboard.mixEyebrow")}
          title={t("dashboard.mixHeading")}
          icon={<UiMusicNote className="section-head__ic" />}
        />
        <div className="section-head__tools">
          <button
            type="button"
            className="text-btn"
            onClick={() => onOpenSection("libreria")}
          >
            {t("dashboard.mixOpenLibrary")}
          </button>
        </div>
      </div>
      <div className="dashboard-mix-body">
        <div className="dashboard-mix-panels">
          <div className="dashboard-mix-panel dashboard-mix-panel--genres">
            <div className="dashboard-mix-panel__head">
              <span className="dashboard-mix-panel__eyebrow">
                {t("dashboard.mixGenresEyebrow")}
              </span>
            </div>
            {topGenresByCount.length === 0 ? (
              <p className="panel-empty">{t("dashboard.mixNoGenresHint")}</p>
            ) : (
              <div className="dashboard-mix-genre-chips">
                {topGenresByCount.map((g) => {
                  const on = genreKey === g.key;
                  return (
                    <button
                      key={g.key}
                      type="button"
                      className={`dashboard-mix-genre-chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() =>
                        setGenreKey((prev) => (prev === g.key ? null : g.key))
                      }
                    >
                      <span className="dashboard-mix-genre-chip__label">
                        {g.label}
                      </span>
                      <span className="dashboard-mix-genre-chip__count">
                        {g.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dashboard-mix-panel dashboard-mix-panel--moods">
            <div className="dashboard-mix-mood-toolbar">
              <span className="dashboard-mix-panel__eyebrow">
                {t("library.moodMatchEyebrow")}
              </span>
              <div
                className="dashboard-mix-match segmented segmented--joined"
                role="group"
                aria-label={t("library.moodMatchAria")}
              >
                <button
                  type="button"
                  className={moodMatchMode === "any" ? "is-on" : ""}
                  onClick={() => setMoodMatchMode("any")}
                >
                  <span className="segmented__btn-inner">
                    <span>{t("library.moodMatchAny")}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={moodMatchMode === "all" ? "is-on" : ""}
                  onClick={() => setMoodMatchMode("all")}
                >
                  <span className="segmented__btn-inner">
                    <span>{t("library.moodMatchAll")}</span>
                  </span>
                </button>
              </div>
            </div>
            <div className="dashboard-mix-mood-grid">
              {TRACK_MOOD_IDS.map((id) => {
                const count = moodOccurrenceCountById.get(id) ?? 0;
                const on = moodFilterIds.includes(id);
                const disabled = count === 0 && !on;
                return (
                  <button
                    type="button"
                    key={id}
                    disabled={disabled}
                    className={`library-mood-filter-btn${
                      on ? " library-mood-filter-btn--on" : ""
                    }`}
                    style={
                      { ["--mood-c"]: TRACK_MOOD_COLORS[id] } as CSSProperties
                    }
                    aria-pressed={on}
                    title={t(`trackMeta.mood.${id}`)}
                    onClick={() => {
                      if (disabled) return;
                      setMoodFilterIds((prev) =>
                        prev.includes(id)
                          ? prev.filter((x) => x !== id)
                          : [...prev, id]
                      );
                    }}
                  >
                    <span className="library-mood-filter-btn__glyph-row">
                      <TrackMoodGlyph mood={id} />
                      <span className="library-mood-filter-btn__count">
                        {count}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="dashboard-mix-footer">
          <p className="subtle sm dashboard-mix-footer__hint">
            {hasFilter
              ? t("dashboard.mixNTracks", { n: shuffleEligible.length })
              : t("dashboard.mixFallbackHint")}
          </p>
          <button
            type="button"
            className="primary-btn dashboard-mix-footer__listen"
            disabled={!hasFilter || shuffleEligible.length === 0}
            onClick={playMixShuffle}
          >
            {t("nav.listen")}
          </button>
        </div>
      </div>
    </section>
  );
}
