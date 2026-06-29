import { memo } from "react";
import { useI18n } from "../../../i18n/useI18n";
import { RekordBrandLogo } from "../../RekordBrandLogo";
import { UiAutorenew, UiSearch } from "../../RekordUiIcons";
import { NAV_DEF } from "../../../lib/routing";
import type { AppSection } from "../../../types";
import styles from "./TopBar.module.css";

interface TopBarProps {
  activeSection: AppSection;
  syncBusy: boolean;
  syncStatusTitle: string;
  syncTapAnim: boolean;
  librarySearchBarOpen: boolean;
  onSync: () => void;
  onToggleSearch: () => void;
}

export const TopBar = memo(function TopBar({
  activeSection,
  syncBusy,
  syncStatusTitle,
  syncTapAnim,
  librarySearchBarOpen,
  onSync,
  onToggleSearch,
}: TopBarProps) {
  const { t } = useI18n();

  const currentNavItem = NAV_DEF.find((item) => item.id === activeSection);
  const sectionTitle = currentNavItem ? t(currentNavItem.labelKey) : "RE-KORD";

  return (
    <header className={`${styles.topbar} rekord-context-header`} role="banner">
      <h1 className={styles.srOnly}>{sectionTitle}</h1>

      <div className={styles.row}>
        <div className={styles.start}>
          <div className={styles.brand} aria-hidden>
            <RekordBrandLogo
              className="rekord-brand-logo rekord-brand-logo--topbar"
              decorative
            />
          </div>
          <div className={styles.titleBlock}>
            <p className={styles.breadcrumb} aria-hidden>
              RE-KORD
            </p>
            <span className={styles.pageTitle} aria-hidden>
              {sectionTitle}
            </span>
          </div>
        </div>

        <div className={styles.end}>
          <button
            type="button"
            className={[
              "ghost-btn ghost-btn--toolbar topbar2__sync-btn",
              syncBusy ? "is-loading" : "",
              syncTapAnim ? "is-tap" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={onSync}
            disabled={syncBusy}
            title={syncStatusTitle}
            aria-label={t("topbar.sync")}
            aria-busy={syncBusy}
          >
            <span className="topbar2__sync-ic" aria-hidden>
              <UiAutorenew />
            </span>
          </button>

          <button
            type="button"
            className={[
              "ghost-btn ghost-btn--toolbar topbar2__search-btn",
              librarySearchBarOpen ? "is-on" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggleSearch}
            title={
              librarySearchBarOpen
                ? t("topbar.closeSearch")
                : t("topbar.openSearch")
            }
            aria-label={
              librarySearchBarOpen
                ? t("topbar.closeSearch")
                : t("topbar.openSearch")
            }
            aria-controls={
              activeSection === "libreria" ? "library-search-input" : undefined
            }
          >
            <span className="topbar2__search-btn-ic" aria-hidden>
              <UiSearch />
            </span>
          </button>
        </div>
      </div>
    </header>
  );
});
