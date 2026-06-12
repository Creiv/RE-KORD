import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { getEntityInfo, mediaUrl } from "../lib/api";
import type { EntityInfoBundle } from "../types";
import { UiAutoAwesome } from "./RekordUiIcons";

type EntityInfoActionProps = {
  /** Cartella artista (= artistId dell'indice). */
  artistDir: string;
  /** Cartella album; assente = info dell'artista. */
  albumDir?: string | null;
  /** Titolo mostrato nel dialog (nome artista o album). */
  title: string;
};

const EMPTY_BUNDLE: EntityInfoBundle = { items: [], image: null };

function artistImageUrl(artistDir: string, bundle: EntityInfoBundle) {
  if (!bundle.image) return null;
  const base = mediaUrl(`${artistDir}/${bundle.image}`);
  const v = bundle.items[0]?.savedAt
    ? encodeURIComponent(bundle.items[0].savedAt)
    : "";
  if (!v) return base;
  return base.includes("?") ? `${base}&v=${v}` : `${base}?v=${v}`;
}

/**
 * "Curiosità": compare solo se per l'entità esistono voci salvate nella
 * lingua dell'app (Studio → Metadati → Opzionali) e apre un dialog di
 * lettura a schede con la foto dell'artista. Il dialog è in portal su body:
 * i contenitori di pagina (hero, vetro) creano stacking context che
 * intrappolerebbero il backdrop.
 */
export function EntityInfoAction({
  artistDir,
  albumDir = null,
  title,
}: EntityInfoActionProps) {
  const { t, locale } = useI18n();
  const [bundle, setBundle] = useState<EntityInfoBundle>(EMPTY_BUNDLE);
  const [artistBundle, setArtistBundle] =
    useState<EntityInfoBundle>(EMPTY_BUNDLE);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    let active = true;
    setBundle(EMPTY_BUNDLE);
    setArtistBundle(EMPTY_BUNDLE);
    setOpen(false);
    if (!artistDir) return;
    getEntityInfo(artistDir, albumDir ?? undefined)
      .then((next) => {
        if (active) setBundle(next);
      })
      .catch(() => {
        if (active) setBundle(EMPTY_BUNDLE);
      });
    if (albumDir) {
      // La foto vive sull'artista: serve anche nel dialog dell'album.
      getEntityInfo(artistDir)
        .then((next) => {
          if (active) setArtistBundle(next);
        })
        .catch(() => {
          if (active) setArtistBundle(EMPTY_BUNDLE);
        });
    }
    return () => {
      active = false;
    };
  }, [artistDir, albumDir]);

  const items = useMemo(
    () => bundle.items.filter((it) => it.lang === locale),
    [bundle.items, locale]
  );

  if (!items.length) return null;

  const photo = artistImageUrl(
    artistDir,
    albumDir ? artistBundle : bundle
  );

  return (
    <>
      <button
        type="button"
        className="ghost-btn entity-info-btn"
        onClick={() => setOpen(true)}
        title={t("entityInfo.buttonTitle")}
      >
        <UiAutoAwesome className="entity-info-btn__ic" />
        {t("entityInfo.button")}
      </button>
      {open
        ? createPortal(
            <div
              className="meta-edit-backdrop"
              role="presentation"
              onClick={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                className="meta-edit-dialog surface-card entity-info-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="entity-info-title"
              >
                <div className="section-head entity-info-dialog__head">
                  <div className="entity-info-dialog__lead">
                    {photo ? (
                      <img
                        className="entity-info-dialog__photo"
                        src={photo}
                        alt=""
                        aria-hidden
                      />
                    ) : null}
                    <div>
                      <p className="eyebrow">
                        {t(
                          albumDir
                            ? "entityInfo.albumEyebrow"
                            : "entityInfo.artistEyebrow"
                        )}
                      </p>
                      <h2 id="entity-info-title">{title}</h2>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => setOpen(false)}
                  >
                    {t("entityInfo.close")}
                  </button>
                </div>
                <div className="entity-info-dialog__body">
                  {items.map((item) => (
                    <article className="entity-info-dialog__item" key={item.id}>
                      {item.title ? (
                        <h3 className="entity-info-dialog__item-title">
                          {item.title}
                        </h3>
                      ) : null}
                      {item.text.split(/\n+/).map((paragraph, i) => (
                        <p key={i}>{paragraph}</p>
                      ))}
                    </article>
                  ))}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
