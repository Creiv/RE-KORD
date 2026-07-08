/**
 * Errori tipizzati per provider metadati esterni.
 */
export class ProviderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ provider?: string, cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider = opts.provider || "unknown";
    if (opts.cause) this.cause = opts.cause;
  }
}

/** @typedef {{ id: string, name: string, search: (query: string, opts?: object) => Promise<unknown[]>, lookup: (id: string, opts?: object) => Promise<unknown | null> }} MetadataProvider */

/** @type {MetadataProvider[]} */
const providers = [];

/**
 * @param {MetadataProvider} provider
 */
export function registerProvider(provider) {
  providers.push(provider);
}

export function listProviders() {
  return providers.map((p) => p.id);
}

/**
 * @param {string} query
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function searchWithFallback(query, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let lastError = null;
  for (const provider of providers) {
    try {
      const result = await withTimeout(provider.search(query, opts), timeoutMs);
      if (Array.isArray(result) && result.length) return { provider: provider.id, results: result };
    } catch (err) {
      lastError = normalizeProviderFailure(provider.id, err);
    }
  }
  if (lastError) throw lastError;
  return { provider: null, results: [] };
}

/**
 * @param {string} providerId
 * @param {string} id
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function lookupProvider(providerId, id, opts = {}) {
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new ProviderError("unavailable", `Provider ${providerId} not registered`, {
      provider: providerId,
    });
  }
  const timeoutMs = opts.timeoutMs ?? 12_000;
  try {
    return await withTimeout(provider.lookup(id, opts), timeoutMs);
  } catch (err) {
    throw normalizeProviderFailure(providerId, err);
  }
}

/**
 * @param {string} providerId
 * @param {unknown} err
 */
function normalizeProviderFailure(providerId, err) {
  if (err instanceof ProviderError) return err;
  const msg = String(err?.message || err);
  if (/429|rate.?limit/i.test(msg)) {
    return new ProviderError("rate_limited", msg, { provider: providerId, cause: err });
  }
  if (/401|403|auth|token/i.test(msg)) {
    return new ProviderError("auth", msg, { provider: providerId, cause: err });
  }
  return new ProviderError("unavailable", msg, { provider: providerId, cause: err });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new ProviderError("unavailable", "Provider timeout")), ms),
    ),
  ]);
}
