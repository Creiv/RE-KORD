import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchConfig, isBackendUnreachableError } from "../../lib/api";
import {
  onBackendRecovery,
  runBackendRecovery,
} from "../../lib/backendRecovery";
import { useBackendRecoveryOnResume } from "../../hooks/useBackendRecoveryOnResume";
import { parseRoute } from "../../lib/routing";
import { EN } from "../../i18n/en";
import { IT } from "../../i18n/it";
import { translate } from "../../i18n/translate";
import styles from "./LibraryRootGate.module.css";

interface LibraryRootGateProps {
  children: ReactNode;
}

type GatePhase = "load" | "ok" | "need" | "readonly" | "unreachable";

export function LibraryRootGate({ children }: LibraryRootGateProps) {
  const [phase, setPhase] = useState<GatePhase>("load");
  const [libraryRootWritable, setLibraryRootWritable] = useState(true);
  const [libraryWritePath, setLibraryWritePath] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const route = parseRoute();

  useBackendRecoveryOnResume();

  const loadConfig = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setPhase("load");
    try {
      const c = await fetchConfig();
      setLibraryRootWritable(c.libraryRootWritable !== false);
      if (c.libraryRootConfigured && c.libraryDataWritable === false) {
        setLibraryWritePath(c.libraryWriteError?.path || c.musicRoot || null);
        setPhase("readonly");
        return;
      }
      if (c.lockedByEnv || c.libraryRootConfigured) setPhase("ok");
      else setPhase("need");
    } catch (err: unknown) {
      if (isBackendUnreachableError(err)) {
        setPhase("unreachable");
        return;
      }
      setLibraryRootWritable(true);
      setPhase("need");
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    return onBackendRecovery(() => {
      void loadConfig({ silent: true });
    });
  }, [loadConfig]);

  const onRetryConnection = useCallback(() => {
    setRetrying(true);
    void runBackendRecovery("gate")
      .then((ok) => {
        if (!ok) setPhase("unreachable");
      })
      .finally(() => {
        setRetrying(false);
      });
  }, []);

  const table =
    typeof navigator !== "undefined" && navigator.language.startsWith("it")
      ? IT
      : EN;

  if (phase === "load") {
    return (
      <div className={`dashboard-grid ${styles.loading}`}>
        <p className="subtle sm">
          {translate(table, "gate.checkingLibrary", undefined)}
        </p>
      </div>
    );
  }

  if (phase === "unreachable") {
    return (
      <div className={`dashboard-grid settings-page ${styles.gate}`}>
        <section className="surface-card">
          <h2>{translate(table, "gate.backendUnreachableTitle", undefined)}</h2>
          <p className="subtle sm">
            {translate(table, "gate.backendUnreachableLead", undefined)}
          </p>
          <button
            type="button"
            className="primary-btn"
            disabled={retrying}
            onClick={onRetryConnection}
          >
            {translate(
              table,
              retrying ? "gate.retryingConnection" : "gate.retryConnection",
              undefined,
            )}
          </button>
        </section>
      </div>
    );
  }

  if (phase === "readonly") {
    return (
      <div className={`dashboard-grid settings-page ${styles.gate}`}>
        <section className="surface-card">
          <h2>{translate(table, "gate.libraryNotWritableTitle", undefined)}</h2>
          <p className="subtle sm">
            {translate(table, "gate.libraryNotWritableLead", {
              path: libraryWritePath || "—",
            })}
          </p>
        </section>
      </div>
    );
  }

  if (phase === "need" && route.section !== "settings") {
    return (
      <div className={`dashboard-grid settings-page ${styles.gate}`}>
        <section className="surface-card">
          <h2>{translate(table, "gate.libraryRequiredTitle", undefined)}</h2>
          <p className="subtle sm">
            {translate(
              table,
              libraryRootWritable
                ? "gate.libraryRequiredLead"
                : "gate.libraryRequiredLeadRemote",
              undefined
            )}
          </p>
          {libraryRootWritable ? (
            <button
              type="button"
              className="primary-btn"
              onClick={() => window.location.assign("/settings")}
            >
              {translate(table, "gate.openSettings", undefined)}
            </button>
          ) : null}
        </section>
      </div>
    );
  }

  return <>{children}</>;
}
