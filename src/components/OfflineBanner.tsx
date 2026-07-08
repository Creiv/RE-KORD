import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";

export function OfflineBanner() {
  const { t } = useI18n();
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="rekord-offline-banner" role="status">
      {t("state.offline")}
    </div>
  );
}
