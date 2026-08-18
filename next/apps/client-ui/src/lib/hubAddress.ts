/**
 * Interpretazione dell'indirizzo dell'hub scritto a mano o letto da un QR.
 *
 * Vive a parte dalla schermata di connessione perche' e' tutta logica di stringhe,
 * l'unica parte davvero sbagliabile del primo avvio: chi installa l'APK digita
 * «192.168.1.20:7420» a mano, e chi inquadra il QR del tunnel ottiene un URL con
 * dentro un percorso.
 */

/** Porta dell'hub: `--bind 0.0.0.0:7420` e' il valore di serie del server. */
export const DEFAULT_HUB_PORT = "7420";

export type HubAddress = {
  /** Origine da salvare come base delle chiamate API: nessuna barra finale. */
  base: string;
  host: string;
  port: string;
  https: boolean;
};

/**
 * Accetta quello che scrive una persona: `192.168.1.20`, `192.168.1.20:7420`,
 * `http://…`, `https://nome.trycloudflare.com`, con o senza percorso in coda.
 * Senza schema si assume http, che in rete locale e' l'unico che l'hub parla.
 */
export function parseHubAddress(raw: string): HubAddress | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const https = url.protocol === "https:";
  // Un URL pubblico gira su 443 e la porta non si scrive: mettercela in coda
  // («https://nome.trycloudflare.com:7420») romperebbe il tunnel.
  const port = url.port || (https ? "" : DEFAULT_HUB_PORT);
  const authority = port ? `${url.hostname}:${port}` : url.hostname;
  return {
    base: `${url.protocol}//${authority}`,
    host: url.hostname,
    port: port || (https ? "443" : DEFAULT_HUB_PORT),
    https,
  };
}

/** Porta valida da mettere in un URL: 1–65535, cifre e nient'altro. */
export function isValidPort(raw: string): boolean {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

/**
 * Indirizzo dai campi «IP» e «porta». Torna null quando manca qualcosa, cosi'
 * il bottone Connetti resta spento invece di provare un URL storto.
 */
export function hubBaseFromParts(host: string, port: string): string | null {
  const h = String(host ?? "").trim();
  if (!h) return null;
  const p = String(port ?? "").trim();
  if (!isValidPort(p)) return null;
  // Chi incolla «http://192.168.1.20:7420» nel campo dell'IP intende quello:
  // l'indirizzo completo vince sulla porta scritta accanto.
  if (/^https?:\/\//i.test(h) || h.includes(":")) {
    const parsed = parseHubAddress(h);
    return parsed ? parsed.base : null;
  }
  return parseHubAddress(`${h}:${p}`)?.base ?? null;
}

/**
 * Come presentare un indirizzo salvato: il tunnel va nel campo dell'URL pubblico,
 * la rete locale nei due campi IP e porta.
 */
export function guessHubMode(raw: string): "local" | "public" {
  const parsed = parseHubAddress(raw);
  if (!parsed) return "local";
  return parsed.https ? "public" : "local";
}

/**
 * Contenuto di un QR → base dell'hub. Il QR del pannello Rete contiene l'URL
 * pubblico in chiaro, ma un QR inquadrato di fretta puo' portarsi dietro un
 * percorso (`/admin`) o arrivare da un pannello che incapsula l'URL in un JSON:
 * in entrambi i casi qui si torna alla sola origine.
 */
export function hubBaseFromQr(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const candidate = data.url ?? data.baseUrl ?? data.publicUrl ?? data.hub;
      if (typeof candidate !== "string") return null;
      return parseHubAddress(candidate)?.base ?? null;
    } catch {
      return null;
    }
  }
  return parseHubAddress(raw)?.base ?? null;
}

/** Etichetta breve per lo stato «mi sto collegando a…»: lo schema non serve. */
export function formatHubLabel(raw: string): string {
  const parsed = parseHubAddress(raw);
  if (!parsed) return String(raw ?? "").trim();
  return parsed.base.replace(/^https?:\/\//i, "");
}
