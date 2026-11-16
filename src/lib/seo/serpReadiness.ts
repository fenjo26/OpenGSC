// Which SERP providers can be configured without an API key.
//
// Kept free of Prisma and of any network call so the same predicate is safe in a server job and
// in a client component. SearXNG is the only keyless provider today: its credential is the
// instance URL, which lives in the server environment and is never sent by the browser.
//
// "Ready here" is a configuration check, not a health check. The Settings card and
// `/api/seo/serp/searxng/status` do the deep probe (a real search) before claiming a connection.

export const SEARXNG_PROVIDER_ID = "searxng";

/** True when the provider needs an API key in addition to (or instead of) a host. */
export function serpProviderNeedsKey(provider: string): boolean {
  return provider !== SEARXNG_PROVIDER_ID;
}

/**
 * True when the caller has enough configuration to attempt a search.
 *
 * For SearXNG that is always true on the server: the base URL is server-side configuration.
 * A misconfigured or unreachable instance still fails at call time with a specific error code,
 * which is the right place to discover it — not silently as "no key configured".
 */
export function serpConfigReady(provider: string, apiKey?: string | null): boolean {
  if (!serpProviderNeedsKey(provider)) return true;
  return String(apiKey ?? "").trim().length > 0;
}

/** The credential shape the browser hands to a request/job. */
export interface SerpCredentialLike {
  provider: string;
  apiKey?: string;
}

/** Client-side mirror of `serpConfigReady` for the localStorage credential shape. */
export function serpCredsReady(creds: SerpCredentialLike): boolean {
  return serpConfigReady(creds.provider, creds.apiKey);
}
