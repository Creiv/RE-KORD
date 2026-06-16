import { memo, useEffect, useState } from "react"
import { usePlayer } from "../context/PlayerContext"
import { useI18n } from "../i18n/useI18n"
import {
  formatSleepTimerRemainingMs,
  parseSleepTimerCustomMinutes,
} from "../lib/sleepTimerFormat"
import { UiChevronRight, UiHistory } from "./RekordUiIcons"

const PRESETS = [15, 30, 60] as const

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "")
}

export const ListenSleepTimer = memo(function ListenSleepTimer() {
  const p = usePlayer()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [customHours, setCustomHours] = useState("0")
  const [customMinutes, setCustomMinutes] = useState("45")
  const [customError, setCustomError] = useState(false)

  useEffect(() => {
    if (!p.sleepTimerEndsAt) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [p.sleepTimerEndsAt])

  const remainingMs = p.sleepTimerEndsAt
    ? Math.max(0, p.sleepTimerEndsAt - now)
    : 0
  const active = Boolean(p.sleepTimerEndsAt && remainingMs > 0)
  const remainingLabel = formatSleepTimerRemainingMs(remainingMs)

  const startTimer = (minutes: number) => {
    p.setSleepTimer(minutes)
    setNow(Date.now())
    setCustomError(false)
    setOpen(false)
  }

  const startCustom = () => {
    const total = parseSleepTimerCustomMinutes(customHours, customMinutes)
    if (total == null) {
      setCustomError(true)
      return
    }
    startTimer(total)
  }

  return (
    <section
      className={`listen-sleep-timer${open ? " is-open" : ""}${active ? " is-active" : ""}`}
      aria-label={t("listen.sleepTimerAria")}
    >
      <button
        type="button"
        className="listen-sleep-timer__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="listen-sleep-timer__toggle-main">
          <UiHistory className="listen-sleep-timer__ic" aria-hidden />
          <span className="listen-sleep-timer__toggle-title">
            {t("listen.sleepTimer")}
          </span>
          {active ? (
            <span className="listen-sleep-timer__badge" aria-live="polite">
              {remainingLabel}
            </span>
          ) : null}
        </span>
        <UiChevronRight
          className={
            open ? "listen-sleep-timer__chev is-open" : "listen-sleep-timer__chev"
          }
          aria-hidden
        />
      </button>

      {open ? (
        <div className="listen-sleep-timer__panel">
          <div className="listen-sleep-timer__row">
            {PRESETS.map((min) => (
              <button
                key={min}
                type="button"
                className="ghost-btn ghost-btn--sm"
                onClick={() => startTimer(min)}
              >
                {t(
                  min === 15
                    ? "player.sleepTimer15"
                    : min === 30
                      ? "player.sleepTimer30"
                      : "player.sleepTimer60",
                )}
              </button>
            ))}

            <label className="listen-sleep-timer__field">
              <span className="listen-sleep-timer__field-label">
                {t("listen.sleepTimerHours")}
              </span>
              <input
                type="text"
                className="ghost-input listen-sleep-timer__input"
                inputMode="numeric"
                autoComplete="off"
                aria-label={t("listen.sleepTimerHours")}
                value={customHours}
                onChange={(event) => {
                  setCustomError(false)
                  setCustomHours(digitsOnly(event.target.value))
                }}
              />
            </label>

            <label className="listen-sleep-timer__field">
              <span className="listen-sleep-timer__field-label">
                {t("listen.sleepTimerMinutes")}
              </span>
              <input
                type="text"
                className="ghost-input listen-sleep-timer__input"
                inputMode="numeric"
                autoComplete="off"
                aria-label={t("listen.sleepTimerMinutes")}
                value={customMinutes}
                onChange={(event) => {
                  setCustomError(false)
                  setCustomMinutes(digitsOnly(event.target.value))
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") startCustom()
                }}
              />
            </label>

            <button
              type="button"
              className="ghost-btn ghost-btn--sm"
              onClick={startCustom}
            >
              {t("listen.sleepTimerStart")}
            </button>

            {active ? (
              <button
                type="button"
                className="text-btn listen-sleep-timer__cancel"
                onClick={() => p.setSleepTimer(null)}
              >
                {t("listen.sleepTimerCancel")}
              </button>
            ) : null}
          </div>

          {customError ? (
            <p className="listen-sleep-timer__error subtle sm" role="alert">
              {t("listen.sleepTimerInvalid")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
})
