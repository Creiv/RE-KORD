import type { LibrarySectionProps } from "./types";

export default function LibrarySection({
  t,
  libLocked,
  libraryRootWritable,
  libraryRootLabel,
  libraryPath,
  setLibraryPath,
  libraryBusy,
  libraryProbeHint,
  libraryErr,
  isKordClientEmbed,
  onSaveLibraryPath,
}: LibrarySectionProps) {
  return (
    <section className="surface-card settings-library-section">
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.libraryEyebrow")}</p>
          <h2>{t("settings.libraryHeading")}</h2>
        </div>
      </div>
      {!libraryRootWritable || isKordClientEmbed ? (
        libLocked ? (
          <p className="subtle sm">
            {t("settings.libLocked", {
              path: libraryPath.trim() || libraryRootLabel || "—",
            })}
          </p>
        ) : (
          <>
            <p className="subtle sm">{t("settings.libraryReadOnlyLead")}</p>
            {libraryRootLabel ? (
              <p className="subtle sm">
                {t("settings.libraryReadOnlyFolder", {
                  name: libraryRootLabel,
                })}
              </p>
            ) : (
              <p className="subtle sm">
                {t("settings.libraryRemoteUnsetLead")}
              </p>
            )}
          </>
        )
      ) : (
        <>
          <p className="subtle sm">{t("settings.libraryRootLead")}</p>
          {libraryProbeHint ? (
            <p className="subtle sm">{libraryProbeHint}</p>
          ) : null}
          {libraryErr ? (
            <p className="subtle sm warnline">{libraryErr}</p>
          ) : null}
          {libLocked ? (
            <p className="subtle sm">
              {t("settings.libLocked", {
                path: libraryPath || "—",
              })}
            </p>
          ) : (
            <div className="settings-inline-form">
              <label className="settings-inline-form__field">
                <span className="sr-only">{t("settings.libPathAria")}</span>
                <input
                  type="text"
                  className="ghost-input w-full"
                  value={libraryPath}
                  onChange={(event) => setLibraryPath(event.target.value)}
                  placeholder={t("settings.libPathPh")}
                  autoComplete="off"
                  aria-label={t("settings.libPathAria")}
                />
              </label>
              <button
                type="button"
                className="primary-btn settings-inline-form__action"
                disabled={libraryBusy || !libraryPath.trim()}
                onClick={onSaveLibraryPath}
              >
                {libraryBusy
                  ? t("settings.saving")
                  : t("settings.saveReload")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
