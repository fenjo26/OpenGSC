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
  {
    tld: "xyz",
    rdap: "https://rdap.centralnic.com/xyz/",
    whoisHost: "whois.nic.xyz",
    minIntervalMs: 1500,
    verified: true,
    notes:
      "CentralNic registry backend. Phase 0, 2026-09-07: 404 on a free name, 200 on a " +
      "registered one. The explicit endpoint matters twice over here: rdap.org does not route " +
      "the zone despite its IANA bootstrap entry, and rdap.org itself 403s in bursts — leaning " +
      "on the bootstrap would have meant no RDAP at all or a throttled one.",
  },
  {
    tld: "fr",
    rdap: "https://rdap.nic.fr/",
    whoisHost: "whois.nic.fr",
    // AFNIC words its free answer "%% NOT FOUND" — the shared `^not found` is anchored to the
    // line start and cannot match past the `%` comment marks, so the zone needs its own pattern.
    availablePatterns: [/^%+\s*not found/im],
    minIntervalMs: 2000,
    verified: true,
    notes:
      "AFNIC. Phase 0, 2026-09-07: endpoint confirmed against the IANA bootstrap and live — " +
      "404 on a free name, 200 with events on a registered one; WHOIS phrasing captured. " +
      "AFNIC also publishes .fr open data, which may remove the need to poll at all.",
  },
  {
    tld: "eu",
    whoisHost: "whois.eu",
    minIntervalMs: 2000,
    verified: true,
    notes:
      "EURid. Phase 0, 2026-09-07: no RDAP exists — the zone is absent from the IANA bootstrap " +
      "and rdap.eu does not answer — so WHOIS is the only source and every free verdict from " +
      "here stays uncorroborated by design. Free phrasing is \"Status: AVAILABLE\", which the " +
      "shared pattern already reads; the legal boilerplate above it parses as registered " +
      "evidence, so the status line is what decides — worth re-checking if EURid rewords it.",
  },

  // ─── Unverified: endpoints to confirm in phase 0 ───────────────────────────
  {
    tld: "gr",
    // No RDAP entry on purpose: guessing one here is exactly the failure this file exists to
    // prevent. With no `rdap`, the checker goes straight to WHOIS and never sees a 404 it
    // could misread as "free".
    // No `whoisHost` either: the registry's port 43 accepts connections and never answers
    // (phase 0, 2026-09-07), the old whois.ics.forth.gr host no longer resolves, and IANA
    // publishes an empty `whois:` line for the zone — so discovery correctly finds nothing
    // and every check lands on "no_usable_source" with its backoff, instead of hanging 8s
    // per row against a dark port or, worse, reading RIPE's "not found" as an answer.
    minIntervalMs: 10_000,
    needsRegistrarConfirm: true,
    verified: false,
    notes:
      "ICS-FORTH. Uncheckable from here as of 2026-09-07: no RDAP, no working public WHOIS. " +
      "Treat .gr as a watchlist of dozens served by a registrar API (phase 6), never as a " +
      "zone to sweep; gr.whois-servers.net points at RIPE, whose \"not found\" proves nothing. " +
      "Never buy on the registry answer alone here.",
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

/**
 * Whether this zone's registry can answer a check at all.
 *
 * `.gr` ships with neither an RDAP endpoint nor a WHOIS host on purpose (phase 0: the registry's
 * port 43 is dark and IANA publishes nothing). Asking anyway costs the zone's `minIntervalMs` of
 * polite silence per row and ends in the same error, so the check route skips such zones up
 * front and tells the user why, instead of backing off into nothing.
 */
export function registryAnswerable(p: RegistryProfile): boolean {
  return Boolean(p.rdap || p.whoisHost);
}

/** Convenience: the profile that governs a whole domain rather than a bare zone. */
export function profileForDomain(domain: string): RegistryProfile | null {
  const tld = tldOf(domain);
  return tld ? resolveProfile(tld) : null;
}

/**
 * The registrable name inside a host: the zone suffix plus one label.
 *
 * `www.example.com` and `blog.example.co.uk` are hosts, not registrations — but the registries
 * answer questions about them as if they were free (a third-level name has no record at
 * Verisign, whose RDAP and WHOIS both report "no match"), so a kept host row is a corroborated
 * false "available" on a domain somebody owns. Lists arrive with hosts in them — crawler
 * outlinks, `www.`-prefixed refdomains — so the row is reduced to the name a person could
 * actually register, which is also the name the whole funnel is about.
 */
export function apexOf(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  const tld = tldOf(clean);
  if (!tld) return null;
  const labels = clean.split(".");
  const suffixLabels = tld.split(".").length;
  return labels.slice(-(suffixLabels + 1)).join(".");
}
