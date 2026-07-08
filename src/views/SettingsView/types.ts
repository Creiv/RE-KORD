import type { ChangeEvent, RefObject } from "react";
import type { Account, AccountsResponse, ActivityLogEntry, RemoteAccessState } from "../../lib/api";
import type { AppLocale, CustomThemeSettings, LibraryIndex, UserSettings, VizMode } from "../../types";

export type SettingsViewProps = {
  index: LibraryIndex | null;
};

export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export type AccountSectionProps = {
  t: TranslateFn;
  accountErr: string | null;
  accounts: AccountsResponse | null;
  selectedAccount: Account | null;
  accountBusy: boolean;
  libLocked: boolean;
  newAccountName: string;
  setNewAccountName: (value: string) => void;
  createNewAccount: () => void;
  selectSessionAccount: (id: string) => void;
  removeAccount: (id: string) => Promise<void>;
  accountLevelFor: (accountId: string) => number | undefined;
};

export type UiSectionProps = {
  t: TranslateFn;
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  settings: UserSettings;
  updateSettings: (patch: Partial<UserSettings>) => void;
  glassOpacityDraft: number;
  onGlassOpacityChange: (value: number) => void;
  customThemeDialogOpen: boolean;
  setCustomThemeDialogOpen: (open: boolean) => void;
};

export type ShortcutsSectionProps = {
  t: TranslateFn;
};

export type LibrarySectionProps = {
  t: TranslateFn;
  libLocked: boolean;
  libraryRootWritable: boolean;
  libraryRootLabel: string | null;
  libraryPath: string;
  setLibraryPath: (value: string) => void;
  libraryBusy: boolean;
  libraryProbeHint: string | null;
  libraryErr: string | null;
  isKordClientEmbed: boolean;
  onSaveLibraryPath: () => void;
};

export type IntegrationsSectionProps = {
  t: TranslateFn;
  youtubeCookiesConfigured: boolean;
  youtubeCookiesLockedByEnv: boolean;
  youtubeCookiesLabel: string | null;
  youtubeCookiesBusy: boolean;
  youtubeCookiesErr: string | null;
  youtubeCookiesOk: string | null;
  youtubeCookiesInputRef: RefObject<HTMLInputElement | null>;
  onYoutubeCookiesFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  removeYoutubeCookies: () => void;
  canManageYoutubeCookies: boolean;
  discogsTokenConfigured: boolean;
  discogsLockedByEnv: boolean;
  discogsTokenDraft: string;
  setDiscogsTokenDraft: (value: string) => void;
  discogsBusy: boolean;
  discogsErr: string | null;
  discogsOk: string | null;
  saveDiscogsTokenHandler: () => void;
  removeDiscogsToken: () => void;
  canManageDiscogs: boolean;
};

export type NetworkSectionProps = {
  t: TranslateFn;
  lanAccessUrl: string | null;
  publicIp: string | null;
  publicIpLoading: boolean;
  remoteAccess: RemoteAccessState | null;
  remoteAccessBusy: boolean;
  remoteAccessErr: string | null;
  remoteLoginHover: boolean;
  setRemoteLoginHover: (hover: boolean) => void;
  remoteShareHover: boolean;
  setRemoteShareHover: (hover: boolean) => void;
  isNetworkControlAllowed: boolean;
  runRemoteCloudflareLogin: () => void;
  logoutRemoteCloudflareLogin: () => void;
  toggleRemoteAccess: () => void;
  copyRemotePublicUrl: () => Promise<void>;
  remoteUrlCopyOk: string | null;
};

export type BackupSectionProps = {
  t: TranslateFn;
  backupBusy: boolean;
  backupOk: string | null;
  backupErr: string | null;
  themeExportBusy: boolean;
  restoreBusy: boolean;
  restoreOk: string | null;
  restoreErr: string | null;
  restoreFileInputRef: RefObject<HTMLInputElement | null>;
  runKordBackup: () => void;
  runThemeExport: () => void;
  onRestoreFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export type ActivitySectionProps = {
  t: TranslateFn;
  locale: AppLocale;
  activityLog: ActivityLogEntry[] | null;
  activityLogErr: string | null;
  activityLogBusy: boolean;
  loadActivityLog: () => void;
  accountNameById: Map<string, string> | null;
};

export type { CustomThemeSettings, VizMode };
