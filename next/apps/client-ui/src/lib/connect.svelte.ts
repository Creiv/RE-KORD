/**
 * Primo avvio: a quale hub ci si collega e con quale account.
 *
 * Nel browser servito dall'hub non si vede niente di tutto questo, perche' l'hub
 * e' l'origine della pagina e risponde subito. Serve nell'APK e nel client
 * desktop, dove l'interfaccia e' dentro l'app e l'hub e' un indirizzo che solo
 * chi installa conosce.
 */

import type { Account } from "./account";
import { getServerBaseUrl, setServerBaseUrl } from "./config";

export type ConnectPhase =
  /** Sonda muta all'avvio: si mostra il logo, non ancora una domanda. */
  | "probing"
  | "connect"
  | "app";

export type ProbeFailure =
  | { reason: "unreachable" }
  | { reason: "timeout" }
  | { reason: "http"; status: number }
  | { reason: "not-hub" }
  | { reason: "no-accounts" };

export type HubProbe =
  | { ok: true; accounts: Account[]; defaultAccountId: string; version: string }
  | ({ ok: false } & ProbeFailure);

/**
 * Sei secondi: un hub in rete locale risponde in millisecondi, e oltre questa
 * soglia chi sta davanti allo schermo ha gia' capito che l'indirizzo e' sbagliato.
 */
const PROBE_TIMEOUT_MS = 6_000;

/** Sonda piu' corta all'avvio: qui si decide solo se mostrare la procedura. */
const STARTUP_PROBE_TIMEOUT_MS = 3_500;

/**
 * Client desktop e hub sulla stessa macchina: il caso normale su un computer, e
 * l'unico indirizzo che si puo' indovinare. Su un telefono la porta e' chiusa e
 * la prova finisce subito, senza far aspettare nessuno.
 */
const LOCAL_HUB = "http://127.0.0.1:7420";
const LOCAL_PROBE_TIMEOUT_MS = 1_500;

async function getJson(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | { status: 0; body: null }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Chiede all'hub «ci sei?» e «che account hai?». Le due domande stanno insieme
 * perche' la risposta utile e' una sola: si puo' entrare, e con quale profilo.
 */
export async function probeHub(
  base: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HubProbe> {
  const root = base.replace(/\/+$/, "");
  let health: { status: number; body: unknown };
  try {
    health = await getJson(`${root}/api/v1/health`, timeoutMs);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  if (health.status !== 200) return { ok: false, reason: "http", status: health.status };
  const info = (health.body ?? {}) as { service?: string; version?: string };
  // Un portale wifi o un altro server sulla stessa porta risponde 200 a tutto:
  // senza questo controllo la procedura si chiuderebbe su un indirizzo che non
  // e' un hub, e l'errore salterebbe fuori dieci schermate dopo.
  if (info.service !== "RE-KORD") return { ok: false, reason: "not-hub" };

  let accounts: { status: number; body: unknown };
  try {
    accounts = await getJson(`${root}/api/v1/accounts`, timeoutMs);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  if (accounts.status !== 200) {
    return { ok: false, reason: "http", status: accounts.status };
  }
  const envelope = (accounts.body ?? {}) as {
    data?: { accounts?: Account[]; defaultAccountId?: string };
  };
  const list = envelope.data?.accounts ?? [];
  if (!list.length) return { ok: false, reason: "no-accounts" };
  return {
    ok: true,
    accounts: list,
    defaultAccountId: envelope.data?.defaultAccountId || list[0].id,
    version: info.version || "",
  };
}

class ConnectGate {
  phase = $state<ConnectPhase>("probing");
  /** Indirizzo da riproporre nei campi: l'ultimo salvato, se c'era. */
  savedBase = $state("");

  /**
   * All'avvio: con un indirizzo gia' salvato si entra e basta — se l'hub non
   * risponde ci pensa il ciclo di riconnessione della sessione, con
   * l'interfaccia in piedi.
   *
   * Senza indirizzo si prova prima l'origine della pagina, che nel browser e'
   * l'hub stesso, e poi l'hub locale. Solo se non risponde nessuno si chiede
   * dove sia: la procedura di primo avvio non deve comparire a chi ha aperto
   * l'interfaccia servita dall'hub.
   */
  async decideOnStart(): Promise<boolean> {
    this.savedBase = getServerBaseUrl();
    if (this.savedBase) {
      this.phase = "app";
      return true;
    }
    const origin = typeof location === "undefined" ? "" : location.origin;
    if (origin.startsWith("http")) {
      const probe = await probeHub(origin, STARTUP_PROBE_TIMEOUT_MS);
      if (probe.ok) {
        this.phase = "app";
        return true;
      }
    }
    const local = await probeHub(LOCAL_HUB, LOCAL_PROBE_TIMEOUT_MS);
    if (local.ok) {
      // Va salvato: nel guscio nativo l'origine e' l'app, e senza base le
      // chiamate finirebbero su tauri://localhost.
      setServerBaseUrl(LOCAL_HUB);
      this.savedBase = LOCAL_HUB;
      this.phase = "app";
      return true;
    }
    this.phase = "connect";
    return false;
  }

  /** Riapre la procedura: dalle impostazioni, o quando l'hub ha cambiato indirizzo. */
  open() {
    this.savedBase = getServerBaseUrl();
    this.phase = "connect";
  }

  close() {
    this.phase = "app";
  }
}

export const connectGate = new ConnectGate();
