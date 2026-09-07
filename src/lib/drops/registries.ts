// Per-zone knowledge: where to ask, how fast we may ask, and whether the answer can be trusted
// without a registrar confirming it.
//
// Every public backorder tool we looked at hard-codes a flat `TLD -> URL` map and one shared set
// of "available" regexes. That works for .com and falls apart silently everywhere else: a zone
// with no RDAP gets a 404 from the bootstrap redirector and is reported free. The profile is the
// place where a zone's exceptions live instead of leaking into the checker.
//
// `verified: false` means the endpoint is a plausible guess that nobody has confirmed against
// the live registry. Phase 0 of docs/DROPS-PLAN.md is exactly the work of turning those into
// `true` — until then the checker treats them as needing corroboration.

export interface RegistryProfile {
  /** Effective TLD, lower case, no leading dot. Multi-label suffixes included ("co.uk"). */
  tld: string;
  /** RDAP base. Absent means the zone goes straight to WHOIS. Must end with "/". */
  rdap?: string;
  /** WHOIS host, port 43. Absent means discover it via whois.iana.org and cache. */
  whoisHost?: string;
  /** Extra "domain is free" patterns on top of the shared set in patterns.ts. */
  availablePatterns?: RegExp[];
  /**
   * Minimum gap between two requests TO THIS REGISTRY. Throttling is per registry, not per
   * domain: 500 .com and 500 .de can run side by side, 200 sequential .com cannot.
   */
  minIntervalMs: number;
  /** The registry's own answer is not good enough to buy on — ask a registrar API first. */
  needsRegistrarConfirm?: boolean;
  /** Confirmed by hand against the live registry (phase 0). */
  verified: boolean;
  notes?: string;
}

/** Bootstrap redirector. Answers for most gTLDs, and answers 404 for anything it cannot route. */
export const RDAP_BOOTSTRAP = "https://rdap.org/domain/";

/**
 * Suffixes that take two labels. Not a public-suffix list — just the ones a drop list realistically
 * contains. Anything not here is treated as a single-label TLD, which is the right default.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz",
  "com.br", "net.br", "org.br",
  "co.jp", "or.jp", "ne.jp", "ac.jp",
  "com.cn", "net.cn", "org.cn",
  "co.in", "net.in", "org.in",
  "com.tr", "net.tr", "org.tr", "gen.tr",
  "com.gr", "net.gr", "org.gr", "edu.gr", "gov.gr",
  "com.pl", "net.pl", "org.pl",
  "co.za", "org.za",
  "com.ua", "net.ua", "org.ua", "in.ua", "kiev.ua",
  "com.mx", "org.mx",
  "co.il", "org.il", "net.il", "ac.il",
]);

/**
 * The effective TLD of a host. `null` for anything that is not a usable domain — the caller
 * treats that as "skip this row", never as "unknown zone, try the bootstrap".
 */
export function tldOf(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean.includes("/") || clean.includes(" ")) return null;
  const parts = clean.split(".");
  if (parts.length < 2 || parts.some(p => p.length === 0)) return null;
  // A TLD always contains a letter. Without this, "999.999.999.999" — an IPv4-shaped row that
  // is not a valid address, so the IP guard lets it past — resolves to the zone "999" and gets
  // asked about at a registry, which cheerfully reports it unregistered.
  const last = parts[parts.length - 1];
  if (!/[a-z\u00a1-\uffff]/.test(last)) return null;
  const two = parts.slice(-2).join(".");
  if (TWO_LABEL_SUFFIXES.has(two)) {
    // A two-label suffix needs a third label to be a registrable name: "co.uk" itself is not.
    return parts.length >= 3 ? two : null;
  }
  return parts[parts.length - 1];
}

const PROFILES: RegistryProfile[] = [
  // ─── Verified: predictable, documented, high volume ────────────────────────
  { tld: "com", rdap: "https://rdap.verisign.com/com/v1/domain/", whoisHost: "whois.verisign-grs.com", minIntervalMs: 1200, verified: true },
  { tld: "net", rdap: "https://rdap.verisign.com/net/v1/domain/", whoisHost: "whois.verisign-grs.com", minIntervalMs: 1200, verified: true },
  { tld: "org", rdap: "https://rdap.publicinterestregistry.net/rdap/domain/", whoisHost: "whois.pir.org", minIntervalMs: 1200, verified: true },
  {
    tld: "de",
    rdap: "https://rdap.denic.de/",
    whoisHost: "whois.denic.de",
    // DENIC answers in its own words and does not use any of the shared phrasings.
    availablePatterns: [/^%+\s*no entries found/im, /^status:\s*free$/im],
    minIntervalMs: 2000,
    verified: true,
    notes: "DENIC throttles hard on WHOIS; RDAP is the path that scales.",
  },
  { tld: "io", rdap: "https://rdap.identitydigital.services/rdap/", whoisHost: "whois.nic.io", minIntervalMs: 1500, verified: true },
  { tld: "me", rdap: "https://rdap.identitydigital.services/rdap/", whoisHost: "whois.nic.me", minIntervalMs: 1500, verified: true },
  { tld: "sh", rdap: "https://rdap.identitydigital.services/rdap/", minIntervalMs: 1500, verified: true },
  { tld: "ac", rdap: "https://rdap.identitydigital.services/rdap/", minIntervalMs: 1500, verified: true },
  { tld: "info", whoisHost: "whois.afilias.net", minIntervalMs: 1500, verified: true },
  { tld: "biz", whoisHost: "whois.nic.biz", minIntervalMs: 1500, verified: true },
  { tld: "co", rdap: "https://rdap.registry.co/co/", whoisHost: "whois.nic.co", minIntervalMs: 1500, verified: true },

  // ─── Unverified: endpoints to confirm in phase 0 ───────────────────────────
  {
    tld: "fr",
    rdap: "https://rdap.nic.fr/",
    whoisHost: "whois.nic.fr",
    minIntervalMs: 2000,
    verified: false,
    notes:
      "AFNIC. RDAP host is a guess — confirm against data.iana.org/rdap/dns.json before trusting " +
      "a 404. AFNIC also publishes .fr open data, which may remove the need to poll at all.",
  },
  {
    tld: "eu",
    minIntervalMs: 2000,
    verified: false,
    notes: "EURid. RDAP endpoint unconfirmed; WHOIS host discovered via IANA until then.",
  },
  {
    tld: "gr",
    // No RDAP entry on purpose: guessing one here is exactly the failure this file exists to
    // prevent. With no `rdap`, the checker goes straight to WHOIS and never sees a 404 it
    // could misread as "free".
    whoisHost: "whois.ics.forth.gr",
    minIntervalMs: 10_000,
    needsRegistrarConfirm: true,
    verified: false,
    notes:
      "ICS-FORTH. Expected to be WHOIS-only and heavily rate-limited — 10s between queries is a " +
      "guess on the safe side. Treat .gr as a watchlist of hundreds on a daily interval, not as " +
      "a zone to sweep. Never buy on the registry answer alone here.",
  },
];

const BY_TLD = new Map(PROFILES.map(p => [p.tld, p]));

/** Every profile we ship, for the settings screen. */
export function allProfiles(): readonly RegistryProfile[] {
  return PROFILES;
}

/**
 * The profile for a zone. Unknown zones get a bootstrap-only profile that is deliberately
 * `verified: false` and slow: we know nothing about it, so we neither hammer it nor believe it.
 */
export function resolveProfile(tld: string): RegistryProfile {
  const key = tld.trim().toLowerCase().replace(/^\./, "");
  const known = BY_TLD.get(key);
  if (known) return known;
  return {
    tld: key,
    rdap: RDAP_BOOTSTRAP,
    minIntervalMs: 3000,
    verified: false,
    notes: "No profile for this zone; routed through the RDAP bootstrap.",
  };
}

/** Convenience: the profile that governs a whole domain rather than a bare zone. */
export function profileForDomain(domain: string): RegistryProfile | null {
  const tld = tldOf(domain);
  return tld ? resolveProfile(tld) : null;
}
