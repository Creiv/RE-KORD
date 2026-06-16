import { describe, expect, it } from "vitest"
import {
  formatSleepTimerRemainingMs,
  parseSleepTimerCustomMinutes,
} from "./sleepTimerFormat"

describe("formatSleepTimerRemainingMs", () => {
  it("usa floor e non aggiunge secondi", () => {
    expect(formatSleepTimerRemainingMs(30 * 60_000 + 800)).toBe("30:00")
    expect(formatSleepTimerRemainingMs(30 * 60_000)).toBe("30:00")
    expect(formatSleepTimerRemainingMs(59_999)).toBe("0:59")
  })

  it("formatta ore", () => {
    expect(formatSleepTimerRemainingMs(3661_000)).toBe("1:01:01")
  })
})

describe("parseSleepTimerCustomMinutes", () => {
  it("accetta ore e minuti", () => {
    expect(parseSleepTimerCustomMinutes("1", "30")).toBe(90)
    expect(parseSleepTimerCustomMinutes("0", "45")).toBe(45)
  })

  it("rifiuta durate fuori range", () => {
    expect(parseSleepTimerCustomMinutes("0", "0")).toBeNull()
    expect(parseSleepTimerCustomMinutes("13", "0")).toBeNull()
  })
})
