import type { BackupSectionProps } from "./types";

export default function BackupSection({
  t,
  backupBusy,
  backupOk,
  backupErr,
  themeExportBusy,
  restoreBusy,
  restoreOk,
  restoreErr,
  restoreFileInputRef,
  runKordBackup,
  runThemeExport,
  onRestoreFileChange,
}: BackupSectionProps) {
  return (
    <section
      className="surface-card settings-activity-section"
      aria-label={t("settings.backupHeading")}
    >
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.backupEyebrow")}</p>
          <h2>{t("settings.backupHeading")}</h2>
        </div>
        <div className="settings-backup-actions">
          <button
            type="button"
            className="ghost-btn ghost-btn--sm"
            disabled={backupBusy || restoreBusy}
            onClick={runKordBackup}
          >
            {backupBusy
              ? t("settings.backupRunning")
              : t("settings.backupCta")}
          </button>
          <button
            type="button"
            className="ghost-btn ghost-btn--sm"
            disabled={themeExportBusy || restoreBusy}
            onClick={runThemeExport}
          >
            {themeExportBusy
              ? t("settings.themeExportRunning")
              : t("settings.themeExportCta")}
          </button>
          <input
            ref={restoreFileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label={t("settings.restoreCta")}
            onChange={onRestoreFileChange}
          />
          <button
            type="button"
            className="ghost-btn ghost-btn--sm"
            disabled={restoreBusy || backupBusy}
            onClick={() => restoreFileInputRef.current?.click()}
          >
            {restoreBusy
              ? t("settings.restoreRunning")
              : t("settings.restoreCta")}
          </button>
        </div>
      </div>
      {backupErr ? <p className="subtle sm warnline">{backupErr}</p> : null}
      {backupOk ? <p className="subtle sm">{backupOk}</p> : null}
      {restoreErr ? (
        <p className="subtle sm warnline">{restoreErr}</p>
      ) : null}
      {restoreOk ? <p className="subtle sm">{restoreOk}</p> : null}
    </section>
  );
}
