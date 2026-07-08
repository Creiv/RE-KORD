import type { ActivitySectionProps } from "./types";

export default function ActivitySection({
  t,
  locale,
  activityLog,
  activityLogErr,
  activityLogBusy,
  loadActivityLog,
  accountNameById,
}: ActivitySectionProps) {
  return (
    <section
      className="surface-card settings-activity-section"
      aria-label={t("settings.activityLogHeading")}
    >
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.activityLogEyebrow")}</p>
          <h2>{t("settings.activityLogHeading")}</h2>
        </div>
        <button
          type="button"
          className="ghost-btn ghost-btn--sm"
          disabled={activityLogBusy}
          onClick={loadActivityLog}
        >
          {activityLogBusy
            ? t("settings.saving")
            : t("settings.activityLogReload")}
        </button>
      </div>
      {activityLogErr ? (
        <p className="subtle sm warnline">{activityLogErr}</p>
      ) : null}
      {activityLog && !activityLog.length ? (
        <p className="subtle sm">{t("settings.activityLogEmpty")}</p>
      ) : null}
      {activityLog && activityLog.length > 0 ? (
        <div
          className="activity-log-scroll"
          style={{ maxHeight: "22rem", overflow: "auto" }}
        >
          <table className="activity-log-table">
            <thead>
              <tr>
                <th>{t("settings.activityLogColTime")}</th>
                <th>{t("settings.activityLogColAccount")}</th>
                <th>{t("settings.activityLogColKind")}</th>
                <th>{t("settings.activityLogColAction")}</th>
                <th>{t("settings.activityLogColFolder")}</th>
                <th>{t("settings.activityLogColDetail")}</th>
              </tr>
            </thead>
            <tbody>
              {activityLog.map((row, i) => (
                <tr key={`${row.ts}-${i}`}>
                  <td className="activity-log-td-nowrap">
                    {new Date(row.ts).toLocaleString(locale, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </td>
                  <td
                    className="activity-log-td-clip"
                    title={row.accountId}
                  >
                    {accountNameById?.get(row.accountId) ?? row.accountId}
                  </td>
                  <td>{row.kind}</td>
                  <td>{row.action}</td>
                  <td
                    className="activity-log-td-clip"
                    title={row.folder || ""}
                  >
                    {row.folder || "—"}
                  </td>
                  <td
                    className="activity-log-td-clip"
                    title={row.detail || ""}
                  >
                    {row.detail || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
