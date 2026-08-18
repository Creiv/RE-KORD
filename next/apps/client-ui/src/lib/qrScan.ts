/**
 * Lettura del QR dell'hub con la fotocamera.
 *
 * Esiste solo dentro il guscio nativo su telefono: nel browser e sul desktop il
 * plugin non e' registrato, quindi il bottone «inquadra il QR» non si mostra
 * affatto invece di comparire e poi fallire (vedi `qrScannerAvailable`).
 */

type ScannerModule = typeof import("@tauri-apps/plugin-barcode-scanner");

export type QrScanOutcome =
  | { status: "ok"; text: string }
  /** L'utente ha chiuso la fotocamera: nessun messaggio da mostrare. */
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "error"; message: string };

let modulePromise: Promise<ScannerModule | null> | null = null;

function inNativeShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Il modulo si carica a richiesta: nel build per il browser resta un chunk mai chiesto. */
async function loadScanner(): Promise<ScannerModule | null> {
  if (!inNativeShell()) return null;
  if (!modulePromise) {
    modulePromise = import("@tauri-apps/plugin-barcode-scanner").catch(() => null);
  }
  return modulePromise;
}

/**
 * Vero solo dove la fotocamera si puo' davvero aprire. Il controllo dei permessi
 * fa da sonda: sul desktop il plugin non c'e' e la chiamata fallisce subito,
 * senza chiedere niente all'utente.
 */
export async function qrScannerAvailable(): Promise<boolean> {
  const mod = await loadScanner();
  if (!mod) return false;
  try {
    await mod.checkPermissions();
    return true;
  } catch {
    return false;
  }
}

/**
 * Apre la fotocamera a tutto schermo e torna il contenuto del primo QR letto.
 * Il permesso si chiede solo qui, quando l'utente ha toccato il bottone: una
 * richiesta all'avvio, prima di spiegare a cosa serve, si nega per riflesso.
 */
export async function scanQrCode(): Promise<QrScanOutcome> {
  const mod = await loadScanner();
  if (!mod) return { status: "error", message: "scanner-unavailable" };
  try {
    // Il valore si confronta come stringa: fra le versioni del plugin l'insieme
    // degli stati cambia («prompt», «prompt-with-rationale»), e l'unico che qui
    // conta e' «granted».
    let permission = String(await mod.checkPermissions());
    if (permission !== "granted") permission = String(await mod.requestPermissions());
    if (permission !== "granted") return { status: "denied" };
    const result = await mod.scan({
      // A tutto schermo: la modalita' «windowed» disegna la fotocamera dietro la
      // webview e vorrebbe la pagina trasparente, cioe' tutta l'interfaccia da
      // rifare per un bottone.
      windowed: false,
      formats: [mod.Format.QRCode],
    });
    const text = String(result?.content ?? "").trim();
    if (!text) return { status: "cancelled" };
    return { status: "ok", text };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Chiudere la fotocamera col tasto indietro arriva qui come errore.
    if (/cancel/i.test(message)) return { status: "cancelled" };
    if (/permission|denied/i.test(message)) return { status: "denied" };
    return { status: "error", message };
  }
}
