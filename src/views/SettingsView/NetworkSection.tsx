import { QrCodeImg } from "../../components/QrCodeImg";
import type { NetworkSectionProps } from "./types";

export default function NetworkSection({
  t,
  lanAccessUrl,
  publicIp,
  publicIpLoading,
  remoteAccess,
  remoteAccessBusy,
  remoteAccessErr,
  remoteLoginHover,
  setRemoteLoginHover,
  remoteShareHover,
  setRemoteShareHover,
  isNetworkControlAllowed,
  runRemoteCloudflareLogin,
  logoutRemoteCloudflareLogin,
  toggleRemoteAccess,
  copyRemotePublicUrl,
  remoteUrlCopyOk,
}: NetworkSectionProps) {
  return (
    <section className="surface-card settings-network-section">
      <div className="settings-network-section__layout">
        <div className="settings-network-section__main">
          <div className="section-head section-head--page-toolbar">
            <div>
              <p className="eyebrow">{t("settings.networkEyebrow")}</p>
              <h2>{t("settings.networkHeading")}</h2>
            </div>
          </div>
          <div className="settings-network-main">
            {lanAccessUrl ? (
              <p className="subtle sm">
                {t("settings.networkUrlHint", { url: lanAccessUrl })}
              </p>
            ) : (
              <p className="subtle sm">{t("settings.networkNoUrl")}</p>
            )}
            {publicIpLoading ? (
              <p className="subtle sm">{t("settings.networkPublicIpLoading")}</p>
            ) : publicIp ? (
              <p className="subtle sm">
                {t("settings.networkPublicIpHint", { ip: publicIp })}
              </p>
            ) : (
              <p className="subtle sm">{t("settings.networkPublicIpUnavailable")}</p>
            )}
            {isNetworkControlAllowed ? (
              <>
                <div className="settings-network-actions">
                  <button
                    type="button"
                    className={`ghost-btn ghost-btn--sm settings-remote-btn${
                      remoteAccess?.cloudflareLoggedIn ? " is-remote-on" : ""
                    }`}
                    disabled={remoteAccessBusy}
                    onMouseEnter={() => setRemoteLoginHover(true)}
                    onMouseLeave={() => setRemoteLoginHover(false)}
                    onClick={() => {
                      if (remoteAccess?.cloudflareLoggedIn) {
                        logoutRemoteCloudflareLogin();
                      } else {
                        runRemoteCloudflareLogin();
                      }
                    }}
                  >
                    {remoteAccess?.cloudflareLoggedIn
                      ? remoteLoginHover
                        ? t("settings.remoteLogout")
                        : t("settings.remoteLoginDone")
                      : t("settings.remoteLogin")}
                  </button>
                  <button
                    type="button"
                    className={`primary-btn primary-btn--sm settings-remote-btn${
                      remoteAccess?.status === "starting"
                        ? " is-remote-starting"
                        : remoteAccess?.status === "running"
                          ? " is-remote-on"
                          : ""
                    }`}
                    disabled={remoteAccessBusy}
                    onMouseEnter={() => setRemoteShareHover(true)}
                    onMouseLeave={() => setRemoteShareHover(false)}
                    onClick={toggleRemoteAccess}
                  >
                    {remoteAccess?.status === "starting"
                      ? "Starting"
                      : remoteAccess?.status === "running"
                        ? remoteShareHover
                          ? t("settings.remoteStopSharing")
                          : t("settings.remoteShared")
                        : t("settings.remoteStart")}
                  </button>
                </div>
                {remoteAccess?.publicUrl ? (
                  <p className="subtle sm">
                    {t("settings.remoteUrl", { url: remoteAccess.publicUrl })}
                  </p>
                ) : null}
              </>
            ) : remoteAccess?.publicUrl ? (
              <p className="subtle sm">
                {t("settings.remoteUrl", { url: remoteAccess.publicUrl })}
              </p>
            ) : (
              <p className="subtle sm">{t("settings.remoteNotShared")}</p>
            )}
            {remoteAccessErr || remoteAccess?.error ? (
              <p className="subtle sm warnline">
                {remoteAccessErr || remoteAccess?.error}
              </p>
            ) : null}
          </div>
        </div>
        {remoteAccess?.publicUrl ? (
          <div className="settings-network-qr-wrap">
            <button
              type="button"
              className="settings-network-qr"
              onClick={() => void copyRemotePublicUrl()}
              title={t("settings.remoteQrCopyTitle")}
              aria-label={t("settings.remoteQrCopyAria", {
                url: remoteAccess.publicUrl,
              })}
            >
              <QrCodeImg
                className="settings-network-qr__img"
                value={remoteAccess.publicUrl}
                size={220}
              />
            </button>
            {remoteUrlCopyOk ? (
              <p className="subtle sm settings-network-qr__ok">
                {remoteUrlCopyOk}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
