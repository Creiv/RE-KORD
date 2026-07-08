import type { ShortcutsSectionProps } from "./types";

export default function ShortcutsSection({ t }: ShortcutsSectionProps) {
  return (
    <section className="surface-card settings-shortcuts-section">
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("settings.shortcutsEyebrow")}</p>
          <h2>{t("settings.shortcutsHeading")}</h2>
        </div>
      </div>
      <div className="shortcut-list">
        <div className="shortcut-row">
          <span className="shortcut-keys">
            <kbd className="shortcut-kbd shortcut-kbd--solo">/</kbd>
            <span className="shortcut-keys__sep">
              {t("settings.shortcutOr")}
            </span>
            <kbd className="shortcut-kbd">{t("settings.kbdCtrlK")}</kbd>
          </span>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutSearchDesc")}
          </span>
        </div>
        <div className="shortcut-row">
          <kbd className="shortcut-kbd shortcut-kbd--wide">{t("settings.kbdSpace")}</kbd>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutPlayDesc")}
          </span>
        </div>
        <div className="shortcut-row">
          <span className="shortcut-keys">
            <kbd className="shortcut-kbd shortcut-kbd--solo">
              {t("settings.kbdArrowLeft")}
            </kbd>
            <span className="shortcut-keys__sep">/</span>
            <kbd className="shortcut-kbd shortcut-kbd--solo">
              {t("settings.kbdArrowRight")}
            </kbd>
          </span>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutSeekDesc")}
          </span>
        </div>
        <div className="shortcut-row">
          <kbd className="shortcut-kbd shortcut-kbd--solo">{t("settings.kbdI")}</kbd>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutListenDesc")}
          </span>
        </div>
        <div className="shortcut-row">
          <kbd className="shortcut-kbd shortcut-kbd--solo">{t("settings.kbdP")}</kbd>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutPlectrDesc")}
          </span>
        </div>
        <div className="shortcut-row">
          <kbd className="shortcut-kbd shortcut-kbd--solo">{t("settings.kbdN")}</kbd>
          <span className="shortcut-row__dash" aria-hidden>
            —
          </span>
          <span className="shortcut-row__desc">
            {t("settings.shortcutNebulaDesc")}
          </span>
        </div>
      </div>
    </section>
  );
}
