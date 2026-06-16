import { memo, useCallback, useEffect, useState } from "react"
import { useI18n } from "../../i18n/useI18n"
import { UiCast } from "../RekordUiIcons"
import {
  canUseWebCastSender,
  ensureCastSdkLoaded,
  isWebCastActive,
  toggleWebCastSession,
} from "../../lib/castPlayback"
import { isGoogleCastSenderAvailable } from "../../lib/castMedia"

export const CastControl = memo(function CastControl() {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!canUseWebCastSender()) return
    let cancelled = false
    void ensureCastSdkLoaded().then((ok) => {
      if (!cancelled) setVisible(ok || isGoogleCastSenderAvailable())
    })
    const id = window.setInterval(() => {
      setActive(isWebCastActive())
    }, 800)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const onToggle = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const on = await toggleWebCastSession()
      setActive(on)
    } finally {
      setBusy(false)
    }
  }, [busy])

  if (!visible) return null

  return (
    <button
      type="button"
      className={`player-bar2__ic player-bar2__ic--cast ${active ? "is-on" : ""}`}
      onClick={() => void onToggle()}
      disabled={busy}
      title={active ? t("player.castActive") : t("player.castTitle")}
      aria-label={active ? t("player.castActive") : t("player.castTitle")}
      aria-pressed={active}
    >
      <span
        className="player-bar2__ic-glyph player-bar2__ic-glyph--svg"
        aria-hidden
      >
        <UiCast />
      </span>
    </button>
  )
})
