/** Buffer circolare degli ultimi errori per diagnostica. */
const MAX = 100;
/** @type {Array<{ at: string, message: string, context?: string }>} */
const buffer = [];

/**
 * @param {unknown} err
 * @param {string} [context]
 */
export function recordError(err, context) {
  buffer.push({
    at: new Date().toISOString(),
    message: String(err?.message || err),
    context: context || undefined,
  });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

export function getRecentErrors(limit = 25) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 25));
  return buffer.slice(-n);
}
