import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useAppConfirm } from "../../context/AppConfirmContext";
import {
  useUserSettingsSlice,
  useUserStateActions,
  useUserStateSelector,
  useUserStateStatus,
} from "../../context/UserStateContext";
import { useI18n } from "../../i18n/useI18n";
import {
  clearYoutubeCookies,
  clearDiscogsToken,
  createAccount as createApiAccount,
  deleteAccount as deleteApiAccount,
  downloadKordDataBackup,
  downloadThemeExport,
  fetchAccounts,
  fetchActivityLog,
  fetchConfig,
  fetchServerPublicIp,
  fetchRemoteAccessState,
  fetchUserStateForAccount,
  getRemoteAccessLoginUrl,
  getSelectedAccountId,
  logoutRemoteAccessLogin,
  saveAppConfig,
  saveDiscogsToken,
  probeLibraryStructure,
  setSelectedAccountId,
  startRemoteAccess,
  stopRemoteAccess,
  uploadKordDataRestore,
  uploadYoutubeCookies,
} from "../../lib/api";
import type {
  Account,
  AccountsResponse,
  ActivityLogEntry,
  RemoteAccessState,
} from "../../lib/api";
import { buildAchievementsSnapshot } from "../../lib/achievements";
import type { SettingsViewProps } from "./types";

const LazyAccountSection = lazy(() => import("./AccountSection"));
const LazyUiSection = lazy(() => import("./UiSection"));
const LazyShortcutsSection = lazy(() => import("./ShortcutsSection"));
const LazyLibrarySection = lazy(() => import("./LibrarySection"));
const LazyIntegrationsSection = lazy(() => import("./IntegrationsSection"));
const LazyNetworkSection = lazy(() => import("./NetworkSection"));
const LazyBackupSection = lazy(() => import("./BackupSection"));
const LazyActivitySection = lazy(() => import("./ActivitySection"));
const LazyDiagnosticsSection = lazy(() => import("./DiagnosticsSection"));

const EMPTY_ACCOUNT_LEVELS: ReadonlyMap<string, number> = new Map();

function SectionFallback() {
  return null;
}

export default function SettingsView({ index }: SettingsViewProps) {
  const { settings, updateSettings } = useUserSettingsSlice();
  const { flushUserStateNow } = useUserStateActions();
  const { ready: userReady } = useUserStateStatus();
  const userState = useUserStateSelector((s) => s.state);
  const { t, locale, setLocale } = useI18n();
  const { confirm: appConfirm, alert: appAlert } = useAppConfirm();
  const [libLocked, setLibLocked] = useState(false);
  const [libraryRootWritable, setLibraryRootWritable] = useState(true);
  const [libraryRootLabel, setLibraryRootLabel] = useState<string | null>(null);
  const [libraryPath, setLibraryPath] = useState("");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryProbeHint, setLibraryProbeHint] = useState<string | null>(null);
  const [libraryErr, setLibraryErr] = useState<string | null>(null);
  const [serverLocalAccess, setServerLocalAccess] = useState(() => {
    try {
      const host = String(window.location.hostname || "").toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      return false;
    }
  });
  const [youtubeCookiesConfigured, setYoutubeCookiesConfigured] =
    useState(false);
  const [youtubeCookiesWritable, setYoutubeCookiesWritable] = useState(false);
  const [youtubeCookiesLockedByEnv, setYoutubeCookiesLockedByEnv] =
    useState(false);
  const [youtubeCookiesLabel, setYoutubeCookiesLabel] = useState<string | null>(
    null
  );
  const [youtubeCookiesBusy, setYoutubeCookiesBusy] = useState(false);
  const [youtubeCookiesErr, setYoutubeCookiesErr] = useState<string | null>(
    null
  );
  const [youtubeCookiesOk, setYoutubeCookiesOk] = useState<string | null>(null);
  const youtubeCookiesInputRef = useRef<HTMLInputElement | null>(null);
  const [, setDiscogsConfigured] = useState(false);
  const [discogsTokenConfigured, setDiscogsTokenConfigured] = useState(false);
  const [discogsWritable, setDiscogsWritable] = useState(false);
  const [discogsLockedByEnv, setDiscogsLockedByEnv] = useState(false);
  const [discogsTokenDraft, setDiscogsTokenDraft] = useState("");
  const [discogsBusy, setDiscogsBusy] = useState(false);
  const [discogsErr, setDiscogsErr] = useState<string | null>(null);
  const [discogsOk, setDiscogsOk] = useState<string | null>(null);
  const [customThemeDialogOpen, setCustomThemeDialogOpen] = useState(false);
  const [glassOpacityDraft, setGlassOpacityDraft] = useState(
    settings.glassOpacity
  );
  const glassOpacitySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const glassOpacityPendingRef = useRef<number | null>(null);

  const [prevGlassOpacity, setPrevGlassOpacity] = useState(
    settings.glassOpacity
  );
  if (prevGlassOpacity !== settings.glassOpacity) {
    setPrevGlassOpacity(settings.glassOpacity);
    setGlassOpacityDraft(settings.glassOpacity);
    glassOpacityPendingRef.current = null;
    if (glassOpacitySaveTimer.current) {
      window.clearTimeout(glassOpacitySaveTimer.current);
      glassOpacitySaveTimer.current = null;
    }
    document.documentElement.style.removeProperty("--glass-user-opacity");
  }

  const onGlassOpacityChange = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      const v = Math.min(100, Math.max(0, Math.round(value)));
      setGlassOpacityDraft(v);
      document.documentElement.style.setProperty(
        "--glass-user-opacity",
        String(v / 100)
      );
      if (glassOpacitySaveTimer.current)
        clearTimeout(glassOpacitySaveTimer.current);
      glassOpacityPendingRef.current = v;
      glassOpacitySaveTimer.current = setTimeout(() => {
        glassOpacityPendingRef.current = null;
        updateSettings({ glassOpacity: v });
      }, 500);
    },
    [updateSettings]
  );
  const [lanAccessUrl, setLanAccessUrl] = useState<string | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [publicIpLoading, setPublicIpLoading] = useState(true);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessState | null>(
    null
  );
  const [remoteLoginHover, setRemoteLoginHover] = useState(false);
  const [remoteShareHover, setRemoteShareHover] = useState(false);
  const [remoteAccessBusy, setRemoteAccessBusy] = useState(false);
  const [remoteAccessErr, setRemoteAccessErr] = useState<string | null>(null);
  const [remoteUrlCopyOk, setRemoteUrlCopyOk] = useState<string | null>(null);
  const remoteUrlCopyTimerRef = useRef<number | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [selectedAccountId, setSelectedAccountIdState] = useState<
    string | null
  >(() => getSelectedAccountId());
  const [newAccountName, setNewAccountName] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountErr, setAccountErr] = useState<string | null>(null);
  const [fetchedAccountLevels, setFetchedAccountLevels] = useState<
    Map<string, number>
  >(() => new Map());
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[] | null>(
    null
  );
  const [activityLogErr, setActivityLogErr] = useState<string | null>(null);
  const [activityLogBusy, setActivityLogBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupOk, setBackupOk] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<string | null>(null);
  const [themeExportBusy, setThemeExportBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreOk, setRestoreOk] = useState<string | null>(null);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const [isKordClientEmbed] = useState(() => {
    try {
      return sessionStorage.getItem("rekord-embed") === "client";
    } catch {
      return false;
    }
  });
  const rekordAppVersion = String(import.meta.env.VITE_REKORD_VERSION ?? "5.0.0");

  useEffect(() => {
    Promise.all([fetchConfig(), fetchAccounts()])
      .then(([c, a]) => {
        setLibLocked(c.lockedByEnv);
        setLibraryRootWritable(c.libraryRootWritable !== false);
        setLibraryRootLabel(
          typeof c.libraryRootLabel === "string" && c.libraryRootLabel.trim()
            ? c.libraryRootLabel.trim()
            : null
        );
        setServerLocalAccess(Boolean(c.localAccess));
        setYoutubeCookiesConfigured(Boolean(c.youtubeCookiesConfigured));
        setYoutubeCookiesWritable(Boolean(c.youtubeCookiesWritable));
        setYoutubeCookiesLockedByEnv(Boolean(c.youtubeCookiesLockedByEnv));
        setYoutubeCookiesLabel(
          typeof c.youtubeCookiesLabel === "string" &&
            c.youtubeCookiesLabel.trim()
            ? c.youtubeCookiesLabel.trim()
            : null
        );
        setDiscogsConfigured(Boolean(c.discogsConfigured));
        setDiscogsTokenConfigured(Boolean(c.discogsTokenConfigured));
        setDiscogsWritable(Boolean(c.discogsWritable));
        setDiscogsLockedByEnv(Boolean(c.discogsLockedByEnv));
        setAccounts(a);
        const selected = getSelectedAccountId() || a.defaultAccountId;
        setSelectedAccountIdState(selected);
        setLibraryPath(String(c.musicRoot ?? ""));
        setLanAccessUrl(c.lanAccessUrl);
        setRemoteAccess(c.remoteAccess || null);
        setLibraryErr(null);
        setAccountErr(null);
      })
      .catch((e: unknown) =>
        setAccountErr(e instanceof Error ? e.message : String(e))
      );

    setPublicIpLoading(true);
    fetchServerPublicIp()
      .then((result) => setPublicIp(result.ip))
      .catch(() => setPublicIp(null))
      .finally(() => setPublicIpLoading(false));
  }, []);

  const loadActivityLog = useCallback(() => {
    setActivityLogErr(null);
    setActivityLogBusy(true);
    fetchActivityLog(500)
      .then((d) => setActivityLog(Array.isArray(d.entries) ? d.entries : []))
      .catch((e: unknown) =>
        setActivityLogErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setActivityLogBusy(false));
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      loadActivityLog();
    });
  }, [loadActivityLog]);

  const selectedAccount: Account | null =
    accounts?.accounts.find((account) => account.id === selectedAccountId) ||
    accounts?.accounts[0] ||
    null;

  const accountNameById = useMemo(() => {
    if (!accounts?.accounts?.length) return null;
    return new Map(accounts.accounts.map((a) => [a.id, a.name] as const));
  }, [accounts]);

  const selectedAccountLevel = useMemo(() => {
    if (!userReady || !selectedAccountId || !index) return null;
    return buildAchievementsSnapshot(userState, index).level.level;
  }, [userReady, userState, selectedAccountId, index]);

  const otherAccounts = useMemo(
    () =>
      accounts?.accounts.filter(
        (account) => account.id !== selectedAccountId,
      ) ?? [],
    [accounts, selectedAccountId],
  );

  useEffect(() => {
    if (!index || !otherAccounts.length) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        otherAccounts.map(async (account) => {
          try {
            const state = await fetchUserStateForAccount(account.id);
            const level = buildAchievementsSnapshot(state, index).level.level;
            return [account.id, level] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setFetchedAccountLevels(
        new Map(
          entries.filter(
            (entry): entry is readonly [string, number] => entry != null,
          ),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [otherAccounts, index]);

  const accountLevels =
    index && otherAccounts.length ? fetchedAccountLevels : EMPTY_ACCOUNT_LEVELS;

  const accountLevelFor = useCallback(
    (accountId: string) => {
      if (accountId === selectedAccountId && selectedAccountLevel != null) {
        return selectedAccountLevel;
      }
      return accountLevels.get(accountId);
    },
    [accountLevels, selectedAccountId, selectedAccountLevel],
  );

  const createNewAccount = () => {
    setAccountErr(null);
    setAccountBusy(true);
    createApiAccount({
      name: newAccountName.trim() || t("accounts.newFallback"),
    })
      .then((next) => {
        setAccounts(next);
        window.location.replace(new URL("/", window.location.href).href);
      })
      .catch((e: unknown) =>
        setAccountErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setAccountBusy(false));
  };

  const selectSessionAccount = (id: string) => {
    if (!id || id === selectedAccountId) return;
    flushUserStateNow({ silent: true });
    setSelectedAccountId(id);
    setSelectedAccountIdState(id);
    const url = new URL("/", window.location.href);
    url.searchParams.set("accountId", id);
    window.location.replace(url.toString());
  };

  const runKordBackup = () => {
    setBackupErr(null);
    setBackupOk(null);
    setBackupBusy(true);
    downloadKordDataBackup()
      .then((name) => {
        setBackupOk(t("settings.backupSuccess", { name }));
        window.setTimeout(() => setBackupOk(null), 5000);
      })
      .catch((e: unknown) =>
        setBackupErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setBackupBusy(false));
  };

  const runThemeExport = () => {
    setBackupErr(null);
    setBackupOk(null);
    setThemeExportBusy(true);
    downloadThemeExport()
      .then((name) => {
        setBackupOk(t("settings.themeExportSuccess", { name }));
        window.setTimeout(() => setBackupOk(null), 5000);
      })
      .catch((e: unknown) =>
        setBackupErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setThemeExportBusy(false));
  };

  const onRestoreFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".zip")) {
      setRestoreErr(t("settings.restoreErrNotZip"));
      return;
    }
    setRestoreErr(null);
    setRestoreOk(null);
    setRestoreBusy(true);
    uploadKordDataRestore(f)
      .then((data) => {
        if (data?.themeImported) {
          setRestoreOk(t("settings.themeImportSuccess"));
          window.setTimeout(() => window.location.reload(), 1200);
          return;
        }
        setRestoreOk(t("settings.restoreSuccess"));
        window.setTimeout(() => setRestoreOk(null), 8000);
      })
      .catch((e: unknown) =>
        setRestoreErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setRestoreBusy(false));
  };

  const applyYoutubeCookieConfig = (c: {
    youtubeCookiesConfigured?: boolean;
    youtubeCookiesWritable?: boolean;
    youtubeCookiesLockedByEnv?: boolean;
    youtubeCookiesLabel?: string | null;
  }) => {
    setYoutubeCookiesConfigured(Boolean(c.youtubeCookiesConfigured));
    setYoutubeCookiesWritable(Boolean(c.youtubeCookiesWritable));
    setYoutubeCookiesLockedByEnv(Boolean(c.youtubeCookiesLockedByEnv));
    setYoutubeCookiesLabel(
      typeof c.youtubeCookiesLabel === "string" && c.youtubeCookiesLabel.trim()
        ? c.youtubeCookiesLabel.trim()
        : null
    );
  };

  const onYoutubeCookiesFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!f) return;
    setYoutubeCookiesErr(null);
    setYoutubeCookiesOk(null);
    setYoutubeCookiesBusy(true);
    uploadYoutubeCookies(f)
      .then((c) => {
        applyYoutubeCookieConfig(c);
        setYoutubeCookiesOk(t("settings.youtubeCookiesSaved"));
        window.setTimeout(() => setYoutubeCookiesOk(null), 5000);
      })
      .catch((e: unknown) =>
        setYoutubeCookiesErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setYoutubeCookiesBusy(false));
  };

  const removeYoutubeCookies = () => {
    setYoutubeCookiesErr(null);
    setYoutubeCookiesOk(null);
    setYoutubeCookiesBusy(true);
    clearYoutubeCookies()
      .then((c) => {
        applyYoutubeCookieConfig(c);
        setYoutubeCookiesOk(t("settings.youtubeCookiesCleared"));
        window.setTimeout(() => setYoutubeCookiesOk(null), 5000);
      })
      .catch((e: unknown) =>
        setYoutubeCookiesErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setYoutubeCookiesBusy(false));
  };

  const applyDiscogsConfig = (c: {
    discogsConfigured?: boolean;
    discogsTokenConfigured?: boolean;
    discogsWritable?: boolean;
    discogsLockedByEnv?: boolean;
  }) => {
    setDiscogsConfigured(Boolean(c.discogsConfigured));
    setDiscogsTokenConfigured(Boolean(c.discogsTokenConfigured));
    setDiscogsWritable(Boolean(c.discogsWritable));
    setDiscogsLockedByEnv(Boolean(c.discogsLockedByEnv));
  };

  const saveDiscogsTokenHandler = () => {
    setDiscogsErr(null);
    setDiscogsOk(null);
    setDiscogsBusy(true);
    saveDiscogsToken(discogsTokenDraft.trim())
      .then((c) => {
        applyDiscogsConfig(c);
        setDiscogsTokenDraft("");
        setDiscogsOk(t("settings.discogsTokenSaved"));
        window.setTimeout(() => setDiscogsOk(null), 5000);
      })
      .catch((e: unknown) =>
        setDiscogsErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setDiscogsBusy(false));
  };

  const removeDiscogsToken = () => {
    setDiscogsErr(null);
    setDiscogsOk(null);
    setDiscogsBusy(true);
    clearDiscogsToken()
      .then((c) => {
        applyDiscogsConfig(c);
        setDiscogsTokenDraft("");
        setDiscogsOk(t("settings.discogsTokenCleared"));
        window.setTimeout(() => setDiscogsOk(null), 5000);
      })
      .catch((e: unknown) =>
        setDiscogsErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setDiscogsBusy(false));
  };

  const removeAccount = async (id: string) => {
    if (id === accounts?.defaultAccountId) return;
    const account = accounts?.accounts.find((item) => item.id === id) || null;
    const name = account?.name || id;
    if (
      !(await appConfirm({
        message: t("accounts.removeConfirm", { name }),
        variant: "danger",
      }))
    ) {
      return;
    }
    setAccountErr(null);
    setAccountBusy(true);
    deleteApiAccount(id)
      .then((next) => {
        setAccounts(next);
        if (getSelectedAccountId() !== selectedAccountId) {
          setSelectedAccountIdState(getSelectedAccountId());
        }
        window.location.replace(new URL("/", window.location.href).href);
      })
      .catch((e: unknown) =>
        setAccountErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setAccountBusy(false));
  };

  const runRemoteCloudflareLogin = () => {
    setRemoteAccessErr(null);
    setRemoteAccessBusy(true);
    getRemoteAccessLoginUrl()
      .then((d) => {
        if (d.loginUrl) {
          window.open(d.loginUrl, "_blank", "noopener,noreferrer");
        }
      })
      .catch((e: unknown) =>
        setRemoteAccessErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setRemoteAccessBusy(false));
  };

  const logoutRemoteCloudflareLogin = () => {
    setRemoteAccessErr(null);
    setRemoteAccessBusy(true);
    logoutRemoteAccessLogin()
      .then((s) => setRemoteAccess(s))
      .catch((e: unknown) =>
        setRemoteAccessErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setRemoteAccessBusy(false));
  };

  const refreshRemoteState = useCallback(() => {
    fetchRemoteAccessState()
      .then((s) => {
        setRemoteAccess(s);
        if (s.status !== "error") setRemoteAccessErr(null);
      })
      .catch((e: unknown) =>
        setRemoteAccessErr(e instanceof Error ? e.message : String(e))
      );
  }, []);

  const toggleRemoteAccess = () => {
    setRemoteAccessErr(null);
    setRemoteAccessBusy(true);
    const op =
      remoteAccess?.status === "running" || remoteAccess?.status === "starting"
        ? stopRemoteAccess()
        : startRemoteAccess();
    op.then((s) => {
      setRemoteAccess(s);
    })
      .catch((e: unknown) =>
        setRemoteAccessErr(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setRemoteAccessBusy(false));
  };

  const copyRemotePublicUrl = useCallback(async () => {
    const url = remoteAccess?.publicUrl?.trim();
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("copy failed");
      }
      if (remoteUrlCopyTimerRef.current) {
        window.clearTimeout(remoteUrlCopyTimerRef.current);
      }
      setRemoteUrlCopyOk(t("settings.remoteUrlCopied"));
      remoteUrlCopyTimerRef.current = window.setTimeout(() => {
        setRemoteUrlCopyOk(null);
        remoteUrlCopyTimerRef.current = null;
      }, 4000);
    } catch {
      await appAlert(t("settings.remoteUrlCopyFailed"));
    }
  }, [remoteAccess?.publicUrl, t, appAlert]);

  useEffect(() => {
    const timer = window.setTimeout(() => setRemoteUrlCopyOk(null), 0);
    return () => window.clearTimeout(timer);
  }, [remoteAccess?.publicUrl]);

  useEffect(() => {
    return () => {
      if (remoteUrlCopyTimerRef.current) {
        window.clearTimeout(remoteUrlCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshRemoteState();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshRemoteState]);

  const onSaveLibraryPath = () => {
    setLibraryErr(null);
    setLibraryProbeHint(null);
    setLibraryBusy(true);
    probeLibraryStructure(libraryPath.trim())
      .then((probe) => {
        const estimated = probe.stats.estimatedTracks ?? 0;
        setLibraryProbeHint(
          t("settings.libraryProbeHint", {
            tracks: estimated,
            layout:
              probe.candidates[0]?.layout ||
              "artist/album/track",
          }),
        );
        if (
          estimated === 0 &&
          !window.confirm(t("settings.libraryProbeEmptyConfirm"))
        ) {
          return null;
        }
        return saveAppConfig({ musicRoot: libraryPath.trim() }).then(
          () => true,
        );
      })
      .then((saved) => {
        if (!saved) return;
        window.location.replace(
          new URL("/", window.location.href).href
        );
      })
      .catch((e: unknown) =>
        setLibraryErr(
          e instanceof Error ? e.message : String(e)
        )
      )
      .finally(() => setLibraryBusy(false));
  };

  const isRemoteViewer = !serverLocalAccess;
  const isNetworkControlAllowed = serverLocalAccess && !isKordClientEmbed;

  const canManageYoutubeCookies =
    !isKordClientEmbed &&
    !youtubeCookiesLockedByEnv &&
    (youtubeCookiesWritable || serverLocalAccess);
  const canManageDiscogs =
    !isKordClientEmbed &&
    !discogsLockedByEnv &&
    (discogsWritable || serverLocalAccess);

  return (
    <div
      className={`view-page settings-page${
        isRemoteViewer ? " settings-page--remote" : ""
      }`}
    >
      <section
        className="hero-card hero-card--compact settings-tutorial-card"
        aria-label={t("settings.tutorialLink")}
      >
        <p className="subtle sm settings-tutorial-card__lead">
          {t("settings.tutorialLead")}
        </p>
        <a
          href="https://re-kord.com/tutorial"
          target="_blank"
          rel="noopener noreferrer"
          className="settings-tutorial-card__link"
        >
          <span>{t("settings.tutorialLink")}</span>
          <span className="settings-tutorial-card__link-icon" aria-hidden>
            ↗
          </span>
        </a>
      </section>
      <Suspense fallback={<SectionFallback />}>
        <LazyAccountSection
          t={t}
          accountErr={accountErr}
          accounts={accounts}
          selectedAccount={selectedAccount}
          accountBusy={accountBusy}
          libLocked={libLocked}
          newAccountName={newAccountName}
          setNewAccountName={setNewAccountName}
          createNewAccount={createNewAccount}
          selectSessionAccount={selectSessionAccount}
          removeAccount={removeAccount}
          accountLevelFor={accountLevelFor}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyUiSection
          t={t}
          locale={locale}
          setLocale={setLocale}
          settings={settings}
          updateSettings={updateSettings}
          glassOpacityDraft={glassOpacityDraft}
          onGlassOpacityChange={onGlassOpacityChange}
          customThemeDialogOpen={customThemeDialogOpen}
          setCustomThemeDialogOpen={setCustomThemeDialogOpen}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyShortcutsSection t={t} />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyLibrarySection
          t={t}
          libLocked={libLocked}
          libraryRootWritable={libraryRootWritable}
          libraryRootLabel={libraryRootLabel}
          libraryPath={libraryPath}
          setLibraryPath={setLibraryPath}
          libraryBusy={libraryBusy}
          libraryProbeHint={libraryProbeHint}
          libraryErr={libraryErr}
          isKordClientEmbed={isKordClientEmbed}
          onSaveLibraryPath={onSaveLibraryPath}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyIntegrationsSection
          t={t}
          youtubeCookiesConfigured={youtubeCookiesConfigured}
          youtubeCookiesLockedByEnv={youtubeCookiesLockedByEnv}
          youtubeCookiesLabel={youtubeCookiesLabel}
          youtubeCookiesBusy={youtubeCookiesBusy}
          youtubeCookiesErr={youtubeCookiesErr}
          youtubeCookiesOk={youtubeCookiesOk}
          youtubeCookiesInputRef={youtubeCookiesInputRef}
          onYoutubeCookiesFileChange={onYoutubeCookiesFileChange}
          removeYoutubeCookies={removeYoutubeCookies}
          canManageYoutubeCookies={canManageYoutubeCookies}
          discogsTokenConfigured={discogsTokenConfigured}
          discogsLockedByEnv={discogsLockedByEnv}
          discogsTokenDraft={discogsTokenDraft}
          setDiscogsTokenDraft={setDiscogsTokenDraft}
          discogsBusy={discogsBusy}
          discogsErr={discogsErr}
          discogsOk={discogsOk}
          saveDiscogsTokenHandler={saveDiscogsTokenHandler}
          removeDiscogsToken={removeDiscogsToken}
          canManageDiscogs={canManageDiscogs}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyNetworkSection
          t={t}
          lanAccessUrl={lanAccessUrl}
          publicIp={publicIp}
          publicIpLoading={publicIpLoading}
          remoteAccess={remoteAccess}
          remoteAccessBusy={remoteAccessBusy}
          remoteAccessErr={remoteAccessErr}
          remoteLoginHover={remoteLoginHover}
          setRemoteLoginHover={setRemoteLoginHover}
          remoteShareHover={remoteShareHover}
          setRemoteShareHover={setRemoteShareHover}
          isNetworkControlAllowed={isNetworkControlAllowed}
          runRemoteCloudflareLogin={runRemoteCloudflareLogin}
          logoutRemoteCloudflareLogin={logoutRemoteCloudflareLogin}
          toggleRemoteAccess={toggleRemoteAccess}
          copyRemotePublicUrl={copyRemotePublicUrl}
          remoteUrlCopyOk={remoteUrlCopyOk}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyBackupSection
          t={t}
          backupBusy={backupBusy}
          backupOk={backupOk}
          backupErr={backupErr}
          themeExportBusy={themeExportBusy}
          restoreBusy={restoreBusy}
          restoreOk={restoreOk}
          restoreErr={restoreErr}
          restoreFileInputRef={restoreFileInputRef}
          runKordBackup={runKordBackup}
          runThemeExport={runThemeExport}
          onRestoreFileChange={onRestoreFileChange}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyActivitySection
          t={t}
          locale={locale}
          activityLog={activityLog}
          activityLogErr={activityLogErr}
          activityLogBusy={activityLogBusy}
          loadActivityLog={loadActivityLog}
          accountNameById={accountNameById}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback />}>
        <LazyDiagnosticsSection t={t} />
      </Suspense>
      <footer
        className="settings-colophon"
        role="contentinfo"
        aria-label={t("settings.colophonLine1", { version: rekordAppVersion })}
      >
        <p className="settings-colophon__line">
          {t("settings.colophonLine1", { version: rekordAppVersion })}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine2")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine3")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine4")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine5")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine6")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine7")}
        </p>
        <p className="settings-colophon__subtle subtle sm">
          {t("settings.colophonLine8")}
        </p>
      </footer>
    </div>
  );
}
