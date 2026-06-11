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
 * Admin dal server stesso o, in Docker, dal browser sull'host (gateway bridge).
 * I client LAN restano client normali, come nell'avvio non-Docker.
 * @param {import("express").Request} req
 */
export function isServerAdminRequest(req) {
  if (isLoopbackRequest(req)) return true;
  if (process.env.REKORD_DOCKER === "1") {
    return isDockerGatewayAddress(getClientAddress(req));
  }
  return false;
}
