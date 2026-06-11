/** @param {import("express").Request} req */
function getClientAddress(req) {
  const raw = String(
    req.socket?.remoteAddress || req.connection?.remoteAddress || "",
  );
  return raw.replace(/^::ffff:/, "");
}

export function isLoopbackAddress(addr) {
  const a = String(addr || "").trim();
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a.endsWith("127.0.0.1")
  );
}

/**
 * Gateway Docker (host → container via porta pubblicata).
 * Con Docker Engine (Linux) gli IP reali dei client LAN sono preservati:
 * solo il PC host arriva dal gateway `.1` del bridge (172.16-31.x.1) ed è
 * admin. Con Docker Desktop invece TUTTE le connessioni (host e LAN) sono
 * mascherate dal NAT interno (192.168.65.x o gateway del bridge), quindi
 * chiunque raggiunga la porta pubblicata risulta admin — scelta accettata
 * dal progetto per mantenere le Impostazioni usabili in quel setup.
 */
export function isDockerGatewayAddress(addr) {
  const parts = String(addr || "")
    .trim()
    .split(".")
    .map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a0, a1, a2, a3] = parts;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return a3 === 1;
  if (a0 === 192 && a1 === 168 && a2 === 65) return true;
  return false;
}

/** @param {import("express").Request} req */
function isLoopbackRequest(req) {
  return isLoopbackAddress(getClientAddress(req));
}

/**
 * Richiesta arrivata attraverso il tunnel Cloudflare: cloudflared gira
 * sull'host e inoltra da loopback, quindi senza questo check chiunque
 * conosca l'URL pubblico risulterebbe admin. Si riconosce dagli header
 * che cloudflared aggiunge sempre (cf-connecting-ip / cf-ray) o dall'host
 * *.trycloudflare.com. Header spoofati da un client LAN possono solo
 * DECLASSARE a non-admin, mai promuovere.
 * @param {import("express").Request} req
 */
export function isCloudflareTunnelRequest(req) {
  const h = req.headers || {};
  if (h["cf-connecting-ip"] || h["cf-ray"]) return true;
  const host = String(h.host || "").toLowerCase();
  return host === "trycloudflare.com" || host.endsWith(".trycloudflare.com");
}

/**
 * Admin dal server stesso o, in Docker, dal browser sull'host (gateway bridge).
 * I client LAN restano client normali, come nell'avvio non-Docker.
 * Le richieste via tunnel Cloudflare non sono mai admin anche se arrivano
 * da loopback (è cloudflared a inoltrarle).
 * @param {import("express").Request} req
 */
export function isServerAdminRequest(req) {
  if (isCloudflareTunnelRequest(req)) return false;
  if (isLoopbackRequest(req)) return true;
  if (process.env.REKORD_DOCKER === "1") {
    return isDockerGatewayAddress(getClientAddress(req));
  }
  return false;
}
