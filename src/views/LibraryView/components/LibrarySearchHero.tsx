import type { RefObject } from "react";
import { useI18n } from "../../../i18n/useI18n";
import { UiClose } from "../../../components/RekordUiIcons";

interface LibrarySearchHeroProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchBarClose: () => void;
}

export function LibrarySearchHero({
  search,
  onSearchChange,
  searchInputRef,
  onSearchBarClose,
}: LibrarySearchHeroProps) {
  const { t } = useI18n();

  return (
    <section className="surface-card library-search-hero">
      <div className="library-search-bar" role="search">
        <p className="eyebrow library-search-bar__eyebrow">
          {t("library.searchEyebrow")}
        </p>
        <p className="library-search-bar__title">
          {t("library.searchHeading", {
            q: search.trim() || "—",
          })}
        </p>
        <div className="library-search-bar__field">
          <label className="library-search-bar__input-wrap">
            <span className="sr-only">{t("topbar.searchAria")}</span>
            <input
              ref={searchInputRef}
              id="library-search-input"
              className="ghost-input ghost-input--search"
              type="search"
              name="library-search"
              placeholder={t("topbar.searchPlaceholder")}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              autoComplete="off"
              role="searchbox"
              aria-label={t("topbar.searchAria")}
            />
          </label>
          <button
            type="button"
            className="text-btn library-search-bar__dismiss"
            onClick={onSearchBarClose}
            title={t("topbar.closeSearch")}
            aria-label={t("topbar.closeSearch")}
          >
            <span className="library-search-bar__dismiss-ic" aria-hidden>
              <UiClose />
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
