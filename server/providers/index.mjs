import { registerProvider } from "./registry.mjs";
import { itunesProvider } from "./itunes.mjs";

let bootstrapped = false;

export function bootstrapProviders() {
  if (bootstrapped) return;
  bootstrapped = true;
  registerProvider(itunesProvider);
}

export { ProviderError, searchWithFallback, lookupProvider, listProviders } from "./registry.mjs";
