import { useCallback, useEffect, useState } from "react";
import { fetchDiagnostics, type DiagnosticsPayload } from "../../lib/api";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";

type Props = {
  t: (key: string, vars?: Record<string, string | number>) => string;
};

export default function DiagnosticsSection({ t }: Props) {
  const [data, setData] = useState<DiagnosticsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setData(await fetchDiagnostics());
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="settings-section">
      <h2>{t("settings.diagnostics.title")}</h2>
      <button type="button" className="btn subtle" onClick={() => void load()} disabled={busy}>
        {t("settings.diagnostics.refresh")}
      </button>
      {busy && !data ? <LoadingState /> : null}
      {err ? <ErrorState message={err} onRetry={() => void load()} /> : null}
      {data ? (
        <dl className="settings-diagnostics">
          <dt>{t("settings.diagnostics.version")}</dt>
          <dd>{data.version}</dd>
          <dt>{t("settings.diagnostics.uptime")}</dt>
          <dd>{Math.round(data.uptimeMs / 1000)}s</dd>
          {data.libraryDb ? (
            <>
              <dt>{t("settings.diagnostics.db")}</dt>
              <dd>
                {data.libraryDb.bootstrapped ? "OK" : "pending"} (epoch {data.libraryDb.epoch ?? 0})
              </dd>
            </>
          ) : null}
          {data.recentErrors?.length ? (
            <>
              <dt>{t("settings.diagnostics.errors")}</dt>
              <dd>
                <ul>
                  {data.recentErrors.map((item) => (
                    <li key={`${item.at}-${item.message}`}>
                      {item.at}: {item.message}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
