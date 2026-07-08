import type { IntegrationsSectionProps } from "./types";

export default function IntegrationsSection({
  t,
  youtubeCookiesConfigured,
  youtubeCookiesLockedByEnv,
  youtubeCookiesLabel,
  youtubeCookiesBusy,
  youtubeCookiesErr,
  youtubeCookiesOk,
  youtubeCookiesInputRef,
  onYoutubeCookiesFileChange,
  removeYoutubeCookies,
  canManageYoutubeCookies,
  discogsTokenConfigured,
  discogsLockedByEnv,
  discogsTokenDraft,
  setDiscogsTokenDraft,
  discogsBusy,
  discogsErr,
  discogsOk,
  saveDiscogsTokenHandler,
  removeDiscogsToken,
  canManageDiscogs,
}: IntegrationsSectionProps) {
  return (
    <section className="surface-card settings-integrations-section">
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.integrationsEyebrow")}</p>
          <h2>{t("settings.integrationsHeading")}</h2>
        </div>
      </div>
      <div className="settings-integrations-list">
        <div className="settings-integration-row">
          <div className="settings-integration-row__body">
            <h3 className="settings-integration-block__title">
              {t("settings.youtubeCookiesHeading")}
            </h3>
            <p className="settings-integration-row__lead subtle sm">
              {t("settings.youtubeCookiesLead")}
            </p>
            <p className="settings-integration-row__status subtle sm">
              {youtubeCookiesConfigured
                ? t("settings.youtubeCookiesActive", {
                    name: youtubeCookiesLabel || "cookies.txt",
                  })
                : t("settings.youtubeCookiesMissing")}
            </p>
            {youtubeCookiesLockedByEnv ? (
              <p className="subtle sm warnline">{t("settings.youtubeCookiesEnvLocked")}</p>
            ) : null}
            {!canManageYoutubeCookies && !youtubeCookiesLockedByEnv ? (
              <p className="subtle sm">{t("settings.integrationsReadOnly")}</p>
            ) : null}
            {youtubeCookiesOk ? (
              <p className="settings-integration-row__flash subtle sm">{youtubeCookiesOk}</p>
            ) : null}
            {youtubeCookiesErr ? (
              <p className="subtle sm warnline">{youtubeCookiesErr}</p>
            ) : null}
          </div>
          {canManageYoutubeCookies && !youtubeCookiesLockedByEnv ? (
            <div className="settings-integration-row__actions">
              <input
                ref={youtubeCookiesInputRef}
                type="file"
                accept=".txt,text/plain"
                className="sr-only"
                onChange={onYoutubeCookiesFileChange}
              />
              <button
                type="button"
                className="primary-btn"
                disabled={youtubeCookiesBusy}
                onClick={() => youtubeCookiesInputRef.current?.click()}
              >
                {youtubeCookiesBusy
                  ? t("settings.saving")
                  : t("settings.youtubeCookiesChoose")}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={youtubeCookiesBusy || !youtubeCookiesConfigured}
                onClick={removeYoutubeCookies}
              >
                {t("settings.youtubeCookiesClear")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="settings-integration-row">
          <div className="settings-integration-row__body">
            <h3 className="settings-integration-block__title">
              {t("settings.discogsHeading")}
            </h3>
            <p className="settings-integration-row__lead subtle sm">
              {t("settings.discogsLead")}
            </p>
            <p className="settings-integration-row__status subtle sm">
              {discogsTokenConfigured
                ? t("settings.discogsHintWithToken")
                : t("settings.discogsHintNoToken")}
              {" · "}
              <a
                href="https://www.discogs.com/settings/developers"
                target="_blank"
                rel="noopener noreferrer"
                className="settings-integration-row__link"
              >
                {t("settings.discogsDevLink")}
              </a>
            </p>
            {discogsLockedByEnv ? (
              <p className="subtle sm warnline">{t("settings.discogsEnvLocked")}</p>
            ) : null}
            {!canManageDiscogs && !discogsLockedByEnv ? (
              <p className="subtle sm">{t("settings.integrationsReadOnly")}</p>
            ) : null}
            {discogsOk ? (
              <p className="settings-integration-row__flash subtle sm">{discogsOk}</p>
            ) : null}
            {discogsErr ? (
              <p className="subtle sm warnline">{discogsErr}</p>
            ) : null}
          </div>
          {canManageDiscogs && !discogsLockedByEnv ? (
            <div className="settings-integration-row__actions settings-integration-row__actions--discogs">
              <label className="settings-discogs-form__field">
                <span className="sr-only">{t("settings.discogsTokenAria")}</span>
                <input
                  type="password"
                  className="ghost-input w-full"
                  value={discogsTokenDraft}
                  placeholder={t("settings.discogsTokenPh")}
                  autoComplete="off"
                  onChange={(e) => setDiscogsTokenDraft(e.target.value)}
                />
              </label>
              <div className="settings-integration-row__btn-row">
                <button
                  type="button"
                  className="primary-btn"
                  disabled={discogsBusy || !discogsTokenDraft.trim()}
                  onClick={saveDiscogsTokenHandler}
                >
                  {discogsBusy ? t("settings.saving") : t("settings.discogsSave")}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={discogsBusy || !discogsTokenConfigured}
                  onClick={removeDiscogsToken}
                >
                  {t("settings.discogsClear")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
