/**
 * Pannello Studio → Copertine: selezione album, ricerca artwork e salvataggio.
 * Estratto da ToolsView.tsx (Fase 6): stato e handler restano in ToolsView.
 */
import { useI18n } from "../i18n/useI18n";
import type { ArtworkHit } from "../lib/api";
import type { LibArtist } from "../types";
import { CoverImg } from "./CoverImg";
import { extLinkLabel, sourceLabel } from "./toolsViewShared";

type Props = {
  coverPickArtist: string;
  setCoverPickArtist: (v: string) => void;
  albumForCover: string;
  setAlbumForCover: (v: string) => void;
  libraryArtistsSorted: LibArtist[];
  coverAlbumsForPick: { relPath: string; name: string }[];
  artQuery: string;
  setArtQuery: (v: string) => void;
  artBusy: boolean;
  artRes: ArtworkHit[];
  onUseCurrentForArt: () => void;
  onArtSearch: () => void;
  onApplyCover: (imageUrl: string) => void;
};

export function StudioCoversPane({
  coverPickArtist,
  setCoverPickArtist,
  albumForCover,
  setAlbumForCover,
  libraryArtistsSorted,
  coverAlbumsForPick,
  artQuery,
  setArtQuery,
  artBusy,
  artRes,
  onUseCurrentForArt,
  onArtSearch,
  onApplyCover,
}: Props) {
  const { t } = useI18n();
  return (
      <div
        className="studio-pane tools-art"
        role="region"
        aria-label={t("tools.coversTitle")}
      >
        <div className="studio-covers-split">
          <div className="studio-panel">
            <h4 className="studio-panel-title">
              {t("tools.coversSave")}
            </h4>
            <div className="studio-picker-picks tools-studio-pair-picks tools-cover-save-picks">
              <div>
                <label
                  className="subtle sm block-label"
                  htmlFor="cover-artist-sel"
                >
                  {t("tools.pickerArtist")}
                </label>
                <select
                  id="cover-artist-sel"
                  className="select"
                  value={coverPickArtist}
                  onChange={(e) => {
                    setCoverPickArtist(e.target.value);
                    setAlbumForCover("");
                  }}
                  aria-label={t("tools.pickerArtist")}
                >
                  <option value="">
                    {t("tools.pickerPlaceholder")}
                  </option>
                  {libraryArtistsSorted.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  className="subtle sm block-label"
                  htmlFor="cover-album-sel"
                >
                  {t("tools.pickerAlbum")}
                </label>
                <select
                  id="cover-album-sel"
                  className="select"
                  value={albumForCover}
                  onChange={(e) => setAlbumForCover(e.target.value)}
                  disabled={!coverPickArtist}
                  aria-label={t("tools.coversPickAria")}
                >
                  {!coverPickArtist ? (
                    <option value="">
                      {t("tools.pickerAlbumNeedArtist")}
                    </option>
                  ) : (
                    <>
                      <option value="">{t("tools.pickAlbum")}</option>
                      {coverAlbumsForPick.map((o) => (
                        <option key={o.relPath} value={o.relPath}>
                          {o.name}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
            </div>
            {albumForCover ? (
              <p className="art-target sm">
                <code>{albumForCover}</code>
              </p>
            ) : null}
          </div>

          <div className="studio-panel">
            <h4 className="studio-panel-title">
              {t("tools.coversSearch")}
            </h4>
            <div className="art-fields">
              <label className="art-field art-field--full">
                <span className="subtle sm block-label">
                  {t("tools.coverSearchLabel")}
                </span>
                <input
                  type="text"
                  className="flex1"
                  value={artQuery}
                  onChange={(e) => setArtQuery(e.target.value)}
                  placeholder={t("tools.coverSearchPh")}
                />
              </label>
            </div>
            <div className="studio-inline-actions studio-inline-actions--spaced">
              <button
                type="button"
                className="ghost-btn ghost-btn--sm"
                onClick={onUseCurrentForArt}
              >
                {t("tools.fillFromPlayback")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={onArtSearch}
                disabled={artBusy}
              >
                {artBusy ? t("tools.searching") : t("tools.searchCovers")}
              </button>
            </div>
          </div>
        </div>

        <div className="artgrid2">
          {artRes.map((a, i) => (
            <div key={i + a.artwork} className="artcard2">
              <div className="artcard2-img">
                <CoverImg src={a.artwork} alt="" decoding="async" />
                {a.source ? (
                  <span className="art-src">{sourceLabel(a.source)}</span>
                ) : null}
              </div>
              <div className="artcap2">
                <strong>{a.artist}</strong>
                <br />
                {a.name}
              </div>
              <div className="art-actions">
                <a
                  className="extlink"
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {extLinkLabel(a.url, t("common.open"))}
                </a>
                <button
                  type="button"
                  className="primary-btn primary-btn--sm"
                  disabled={artBusy || !albumForCover}
                  onClick={() => onApplyCover(a.artwork)}
                >
                  {t("tools.saveCover")}
                </button>
              </div>
            </div>
          ))}
        </div>
        {artRes.length === 0 &&
        !artBusy &&
        artQuery.length > 0 ? (
          <p className="subtle sm studio-panel-gap">
            {t("tools.noCoverResults")}
          </p>
        ) : null}
      </div>
  );
}
