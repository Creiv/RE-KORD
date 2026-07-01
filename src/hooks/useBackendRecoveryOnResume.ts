import { useEffect } from "react"
import { scheduleBackendRecovery } from "../lib/backendRecovery"

/**
 * Riconnessione API al ritorno in foreground.
 * Usa solo eventi web + @capacitor/app (stato attività); non tocca playback nativo.
 */
export function useBackendRecoveryOnResume(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return

    const onResume = () => scheduleBackendRecovery("resume")

    const onVisibility = () => {
      if (document.visibilityState === "visible") onResume()
    }

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onResume)
    window.addEventListener("online", onResume)

    let removeCapacitorListener: (() => void) | undefined

    void import("@capacitor/core")
      .then(({ Capacitor }) => {
        if (!Capacitor.isNativePlatform()) return
        return import("@capacitor/app").then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) onResume()
          }),
        )
      })
      .then((handle) => {
        if (handle) removeCapacitorListener = () => handle.remove()
      })
      .catch(() => {
        /* plugin non disponibile (es. test jsdom) */
      })

    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onResume)
      window.removeEventListener("online", onResume)
      removeCapacitorListener?.()
    }
  }, [enabled])
}
