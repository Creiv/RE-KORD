import type { UserSettings, UserSettingsPatch } from "../types";

/** Unisce patch impostazioni preservando i campi già salvati in customTheme. */
export function mergePartialUserSettings(
  prev: Partial<UserSettings> | UserSettingsPatch | undefined,
  patch: UserSettingsPatch,
): UserSettingsPatch {
  const base = prev ?? {};
  const next: UserSettingsPatch = { ...base, ...patch };
  if (patch.customTheme !== undefined) {
    next.customTheme = {
      ...(base.customTheme ?? {}),
      ...patch.customTheme,
    };
  }
  return next;
}

export type { UserSettingsPatch } from "../types";
