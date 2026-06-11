/**
 * Risposte API uniformi ({ok, data, error}), account dalla richiesta,
 * gate libreria e log attività. Estratto da index.mjs (Fase 6).
 */
import { getDefaultAccountId, getMusicRoot } from "./musicRootConfig.mjs";
import { appendActivityLog } from "./activityLog.mjs";

export function sendOk(res, data, status = 200) {
  return res.status(status).json({ ok: true, data, error: null });
}

export function sendError(res, status, error, details = null) {
  return res
    .status(status)
    .json({ ok: false, data: null, error, ...(details ? { details } : {}) });
}

export function apiSkipsLibraryGate(req) {
  const sub = (req.path || "").replace(/\/+$/, "") || "/";
  if (sub === "/config") return true;
  if (sub === "/health") return true;
  if (
    (sub === "/backup/rekord-restore" || sub === "/backup/kord-restore") &&
    req.method === "POST"
  )
    return true;
  if (sub === "/accounts" && req.method === "GET") return true;
  return false;
}
export function accountIdFromReq(req) {
  return (
    String(req.query?.accountId || "").trim() ||
    String(
      req.headers["x-rekord-account-id"] ||
        req.headers["x-kord-account-id"] ||
        "",
    ).trim() ||
    getDefaultAccountId()
  );
}
export function actLog(req, entry) {
  const accountId = accountIdFromReq(req);
  return appendActivityLog({
    accountId,
    musicRoot: getMusicRoot(),
    ...entry,
  });
}
