import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { isStandaloneDisplayMode } from "../lib/routing";

function isPhoneLandscape(): boolean {
  if (!window.matchMedia("(orientation: landscape)").matches) return false;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (!coarse) return false;
  const h = window.visualViewport?.height ?? window.innerHeight;
  return h <= 600;
}

function tryLockPortrait() {
  const lock = screen.orientation?.lock;
  if (!lock) return;
  void lock.call(screen.orientation, "portrait-primary").catch(() => {
    void screen.orientation?.lock?.("portrait").catch(() => {});
  });
}

export function PortraitLockGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [standalone] = useState(() => isStandaloneDisplayMode());
  const [showRotateHint, setShowRotateHint] = useState(
    () => standalone && isPhoneLandscape()
  );

  useEffect(() => {
    if (!standalone) return;
    document.documentElement.dataset.portraitLock = "1";

    const syncLandscape = () => {
      setShowRotateHint(isPhoneLandscape());
    };

    tryLockPortrait();
    window.addEventListener("orientationchange", syncLandscape);
    window.visualViewport?.addEventListener("resize", syncLandscape);
    window.addEventListener("resize", syncLandscape);
    window.addEventListener("orientationchange", tryLockPortrait);
    document.addEventListener("visibilitychange", tryLockPortrait);
    document.addEventListener("pointerdown", tryLockPortrait, { passive: true });

    return () => {
      delete document.documentElement.dataset.portraitLock;
      window.removeEventListener("orientationchange", syncLandscape);
      window.visualViewport?.removeEventListener("resize", syncLandscape);
      window.removeEventListener("resize", syncLandscape);
      window.removeEventListener("orientationchange", tryLockPortrait);
      document.removeEventListener("visibilitychange", tryLockPortrait);
      document.removeEventListener("pointerdown", tryLockPortrait);
    };
  }, [standalone]);

  return (
    <>
      {children}
      {showRotateHint ? (
        <div
          className="portrait-lock-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("portraitLock.title")}
        >
          <div className="portrait-lock-overlay__card">
            <div className="portrait-lock-overlay__icon" aria-hidden>
              <svg viewBox="0 0 48 48" width="48" height="48" fill="currentColor">
                <path d="M14 8h20a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4zm2 4v24h16V12H16z" />
                <path d="M30 18l4 4-4 4v-3h-6v-2h6v-3z" opacity="0.9" />
              </svg>
            </div>
            <p className="portrait-lock-overlay__title">{t("portraitLock.title")}</p>
            <p className="portrait-lock-overlay__body">{t("portraitLock.body")}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
