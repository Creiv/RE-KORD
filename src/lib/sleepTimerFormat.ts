/** Formatta millisecondi residui come countdown m:ss o h:mm:ss (floor, non ceil). */
export function formatSleepTimerRemainingMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  }
  return `${m}:${String(s).padStart(2, "0")}`
}

export const SLEEP_TIMER_MAX_MINUTES = 12 * 60

export function parseSleepTimerCustomMinutes(
  hoursRaw: string,
  minutesRaw: string,
): number | null {
  const h = hoursRaw.trim() === "" ? 0 : Number(hoursRaw)
  const m = minutesRaw.trim() === "" ? 0 : Number(minutesRaw)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || m < 0 || m > 59) return null
  const total = Math.round(h * 60 + m)
  if (total < 1 || total > SLEEP_TIMER_MAX_MINUTES) return null
  return total
}
