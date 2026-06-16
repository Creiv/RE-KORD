import { memo, useCallback } from "react";
import { useRhythmMode } from "../../../context/RhythmModeContext";
import { usePlayer } from "../../../context/PlayerContext";
import { useI18n } from "../../../i18n/useI18n";
import { RekordNavIcon } from "../../RekordUiIcons";
import { RekordBrandLogo } from "../../RekordBrandLogo";
import { NAV_DEF } from "../../../lib/routing";
import type { AppSection } from "../../../types";
import styles from "./SideBar.module.css";

interface SideBarProps {
  activeSection: AppSection;
  onNavigate: (section: AppSection) => void;
  onLibraryHome: () => void;
  onOpenSettings: () => void;
}

export const SideBar = memo(function SideBar({
  activeSection,
  onNavigate,
  onLibraryHome,
  onOpenSettings,
}: SideBarProps) {
  const { t } = useI18n();
  const { open: rhythmOpen, toggle: toggleRhythm } = useRhythmMode();
  const player = usePlayer();

  const handleNavClick = useCallback(
    (id: AppSection) => {
      if (id === "gioco") {
        if (player.queue.length === 0) return;
        toggleRhythm();
        return;
      }
      if (id === "libreria") {
        onLibraryHome();
      } else {
        onNavigate(id);
      }
    },
    [onNavigate, onLibraryHome, player.queue.length, toggleRhythm]
  );

  const coreItems = NAV_DEF.filter((item) => item.group === "core");
  const secondaryItems = NAV_DEF.filter((item) => item.group === "secondary");

  return (
    <aside className={`${styles.sidebar} rekord-icon-rail`} aria-label={t("topbar.navAria")}>
      <div className={styles.header}>
        <div className={styles.brandSlot}>
          <RekordBrandLogo className={styles.brandImg} decorative />
        </div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.navSection}>
          {coreItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem}${
                item.id === "gioco" && rhythmOpen
                  ? ` ${styles.active}`
                  : activeSection === item.id
                    ? ` ${styles.active}`
                    : ""
              }`}
              aria-label={t(item.labelKey)}
              aria-current={activeSection === item.id ? "page" : undefined}
              title={t(item.labelKey)}
              onClick={() => handleNavClick(item.id)}
            >
              <RekordNavIcon section={item.id} className={styles.navIc} />
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
            </button>
          ))}
        </div>

        <hr className={styles.navSep} aria-hidden />

        <div className={styles.navSection}>
          {secondaryItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem}${
                activeSection === item.id ? ` ${styles.active}` : ""
              }`}
              aria-label={t(item.labelKey)}
              aria-current={activeSection === item.id ? "page" : undefined}
              title={t(item.labelKey)}
              onClick={() => handleNavClick(item.id)}
            >
              <RekordNavIcon section={item.id} className={styles.navIc} />
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.footerBtn}
          onClick={onOpenSettings}
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
        >
          <RekordNavIcon section="settings" className={styles.footerBtnIc} />
        </button>
      </div>
    </aside>
  );
});
