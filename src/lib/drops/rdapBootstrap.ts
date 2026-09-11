// Which RDAP server actually speaks for a zone, straight from IANA.
//
// Until now every zone without a hand-written profile was asked through `rdap.org`, a public
// redirector. That works, and it costs the one thing this module cannot afford to lose: the
// meaning of a 404. `rdap.org` answers 404 both for a name that is genuinely unregistered and
// for a zone it has no route for, so `availability.ts` is right to refuse to trust it alone —
// which is why three of the four uncorroborated rows in the catalogue on 2026-09-11 were
// `lastVia: rdap, lastHttp: 404` in zones with no profile (`.cool`, `.bzh`, `.guide`).
//
// IANA publishes the answer: `dns.json` is the official RDAP bootstrap, a list of zone groups
// and the base URLs of the registries that serve them. Asking the registry directly turns that
// ambiguous 404 into an authoritative one — the registry either has a record or it does not,
// and there is no third reading.
//
// This does not make a single 404 into a corroborated verdict. One source is still one source;
// the rule in `availability.ts` stands. It makes the source worth something.

import { safeFetch } from "@/lib/security/safeFetch";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const TIMEOUT_MS = 15_000;
/** The file is a few hundred KB and grows slowly; the cap is generous but not unbounded. */
const MAX_BYTES = 8 * 1024 * 1024;

/** A day. The list changes when a TLD is delegated or changes backend — neither is a daily event. */
const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long to sit still after a failed fetch.
 *
 * Without it, an instance with no egress to `data.iana.org` would try to fetch a multi-hundred-KB
 * file once per domain checked, turn every check into a 15-second timeout, and grind the funnel
 * to a halt — while behaving perfectly well the moment the network came back. Failing loudly is
 * not an option either: the fallback works, so a missing bootstrap must cost nothing.
 */
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;

interface BootstrapCache {
  /** tld (no dot, lower case) → RDAP base URL, always with a trailing slash. */
  byTld: Map<string, string>;
  fetchedAt: number;
  publication?: string;
}

let cache: BootstrapCache | null = null;
let lastFailureAt = 0;
/** One in-flight fetch shared by every caller: a batch starts hundreds of checks at once. */
let inFlight: Promise<BootstrapCache | null> | null = null;

export interface BootstrapShape {
  publication?: string;
  services?: unknown;
}

/**
 * Parse the bootstrap document.
 *
 * Exported so the shape can be tested without a network, which matters more here than usual:
 * every branch below is a defence against a document that is not what we expect, and an
 * untested defence is a guess.
 *
 * The format (RFC 9224) is `services: [ [ [tld, …], [url, …] ], … ]`. A service may list several
 * URLs; HTTPS is preferred and the first one wins otherwise.
 */
export function parseBootstrap(doc: BootstrapShape): Map<string, string> {
  const out = new Map<string, string>();
  const services = Array.isArray(doc?.services) ? doc.services : [];

  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const tlds = Array.isArray(service[0]) ? service[0] : [];
    const urls = Array.isArray(service[1]) ? service[1] : [];

    const candidates = urls
      .map(u => String(u ?? "").trim())
      .filter(u => u.startsWith("https://") || u.startsWith("http://"));
    if (!candidates.length) continue;
    // Prefer HTTPS. A registry that publishes both is telling us it supports both, and there is
    // no reason to ask a registry a question in clear text.
    const chosen = candidates.find(u => u.startsWith("https://")) ?? candidates[0];
    const base = chosen.endsWith("/") ? chosen : `${chosen}/`;

    for (const raw of tlds) {
      const tld = String(raw ?? "").trim().toLowerCase().replace(/^\./, "");
      // The bootstrap's own entries are already punycode for IDN zones, so no conversion here.
      if (tld) out.set(tld, base);
    }
  }
  return out;
}

async function load(): Promise<BootstrapCache | null> {
  try {
    const res = await safeFetch(BOOTSTRAP_URL, {
      headers: { accept: "application/json" },
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      // A public IANA host. Same reasoning as the registry calls: nothing here should reach a
      // private address, and saying so keeps this immune to the instance-wide opt-out.
      allowPrivate: false,
    });
    if (!res.ok) {
      lastFailureAt = Date.now();
      return null;
    }
    const doc = await res.json<BootstrapShape>();
    const byTld = parseBootstrap(doc);
    if (!byTld.size) {
      // A document that parses to nothing is a document we did not understand. Keeping the old
      // cache (if any) beats replacing it with an empty one.
      lastFailureAt = Date.now();
      return cache;
    }
    cache = { byTld, fetchedAt: Date.now(), publication: doc?.publication ? String(doc.publication) : undefined };
    lastFailureAt = 0;
    return cache;
  } catch {
    lastFailureAt = Date.now();
    return null;
  }
}

async function ensure(): Promise<BootstrapCache | null> {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (fresh) return cache;
  // A stale cache is still better than no answer while the refresh is on backoff.
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return cache;
  if (!inFlight) {
    inFlight = load().finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * The registry's own RDAP base for a zone, or null when IANA does not list one.
 *
 * Null is a real answer and not a failure: `.gr` is genuinely absent from the bootstrap, which is
 * half the reason that zone needs a registrar API at all. Callers fall back to whatever their
 * profile already had.
 */
export async function rdapBaseFor(tld: string): Promise<string | null> {
  const key = String(tld ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const loaded = await ensure();
  return loaded?.byTld.get(key) ?? null;
}

/** For the UI and for diagnostics: what we know and how old it is. */
export function bootstrapState(): { loaded: boolean; zones: number; fetchedAt: number | null; publication?: string } {
  return {
    loaded: !!cache,
    zones: cache?.byTld.size ?? 0,
    fetchedAt: cache?.fetchedAt ?? null,
    publication: cache?.publication,
  };
}

/** Tests only — the module-level cache would otherwise leak between cases. */
export function resetBootstrapCacheForTests(): void {
  cache = null;
  lastFailureAt = 0;
  inFlight = null;
}
