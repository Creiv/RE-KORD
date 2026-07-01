import {
  probeBackendHealth,
  resetBackendConnectivityState,
} from "./api"

export type BackendRecoveryReason =
  | "resume"
  | "online"
  | "poll"
  | "manual"
  | "gate"

type BackendRecoveryListener = (reason: BackendRecoveryReason) => void | Promise<void>

const listeners = new Set<BackendRecoveryListener>()
let scheduleTimer: number | null = null
let recoveryInFlight: Promise<boolean> | null = null

export function onBackendRecovery(
  listener: BackendRecoveryListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function runBackendRecovery(
  reason: BackendRecoveryReason,
): Promise<boolean> {
  if (recoveryInFlight) return recoveryInFlight
  recoveryInFlight = (async () => {
    resetBackendConnectivityState()
    const healthy = await probeBackendHealth()
    if (!healthy) return false
    await Promise.all(
      [...listeners].map((listener) => Promise.resolve(listener(reason))),
    )
    return true
  })().finally(() => {
    recoveryInFlight = null
  })
  return recoveryInFlight
}

/** Debounced recovery trigger (resume/online can fire twice in quick succession). */
export function scheduleBackendRecovery(
  reason: BackendRecoveryReason,
  delayMs = 450,
) {
  if (scheduleTimer != null) window.clearTimeout(scheduleTimer)
  scheduleTimer = window.setTimeout(() => {
    scheduleTimer = null
    void runBackendRecovery(reason)
  }, delayMs)
}
