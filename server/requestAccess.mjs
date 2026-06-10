/** @param {import("express").Request} req */
export function getClientAddress(req) {
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

/** Rete privata / gateway Docker (host → container via publish). */
export function isPrivateOrDockerGatewayAddress(addr) {
  const parts = String(addr || "")
    .trim()
    .split(".")
    .map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a0, a1] = parts;
  if (a0 === 10) return true;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
  if (a0 === 192 && a1 === 168) return true;
  if (a0 === 192 && a1 === 65) return true;
  return false;
}

/** @param {import("express").Request} req */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(getClientAddress(req));
}

/**
 * Admin dal server stesso o, in Docker, dal browser sull'host (gateway bridge).
 * @param {import("express").Request} req
 */
export function isServerAdminRequest(req) {
  if (isLoopbackRequest(req)) return true;
  if (process.env.REKORD_DOCKER === "1") {
    return isPrivateOrDockerGatewayAddress(getClientAddress(req));
  }
  return false;
}
