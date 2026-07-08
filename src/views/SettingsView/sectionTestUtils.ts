import { createRef } from "react";
import { EN } from "../../i18n/en";
import { translate } from "../../i18n/translate";
import type { UserSettings } from "../../types";

export const mockT = (key: string, vars?: Record<string, string | number>) =>
  translate(EN, key, vars);

export const noop = () => undefined;

export const defaultUserSettings: UserSettings = {
  theme: "midnight",
  vizMode: "hmb",
  restoreSession: true,
  defaultTab: "dashboard",
  locale: "en",
  libBrowse: "artists",
  libOverviewSort: "name",
  artistAlbumSort: "date",
  audioCrossfadeSec: 3,
  plectrDisableVizBackdrop: false,
  glassSurfaces: false,
  glassOpacity: 62,
};

export function createFileInputRef() {
  return createRef<HTMLInputElement>();
}
