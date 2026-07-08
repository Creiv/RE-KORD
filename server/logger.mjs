/**
 * Logging strutturato RE-KORD (Pino).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import pino from "pino";

/** @type {import('pino').Logger | null} */
let rootLogger = null;

function resolveLogLevel() {
  const raw = String(process.env.REKORD_LOG_LEVEL || "info").toLowerCase();
  if (["trace", "debug", "info", "warn", "error", "fatal"].includes(raw))
    return raw;
  return "info";
}

function buildTransport() {
  const musicRoot = process.env.MUSIC_ROOT;
  if (!musicRoot) return undefined;
  try {
    const logDir = join(musicRoot, ".kord", "global_info", "logs");
    mkdirSync(logDir, { recursive: true });
    return pino.transport({
      targets: [
        { target: "pino/file", options: { destination: 1 }, level: resolveLogLevel() },
        {
          target: "pino-roll",
          options: {
            file: join(logDir, "rekord"),
            frequency: "daily",
            mkdir: true,
            limit: { count: 7 },
          },
          level: resolveLogLevel(),
        },
      ],
    });
  } catch {
    return undefined;
  }
}

/**
 * @returns {import('pino').Logger}
 */
export function getLogger() {
  if (!rootLogger) {
    const transport = buildTransport();
    rootLogger = transport
      ? pino({ level: resolveLogLevel(), name: "rekord" }, transport)
      : pino({ level: resolveLogLevel(), name: "rekord" });
    globalThis.__rekordLogger = { logger: rootLogger };
  }
  return rootLogger;
}

export function requestIdMiddleware(req, res, next) {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  req.requestId = incoming || randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}

/**
 * @param {unknown} err
 * @param {string} [context]
 */
export function logDebugIgnored(err, context = "operation") {
  getLogger().debug({ err, context }, "Ignored error");
}
