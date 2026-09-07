// The cheapest stage of the funnel, and the one that decides whether the rest is affordable.
//
// A registered domain almost always has NS records, and asking a resolver costs nothing and is
// not rate-limited by any registry. Running this first turns a 50 000-row list into roughly
// 5 000 before a single RDAP or WHOIS query is made. Every public backorder tool we looked at
// skips it and goes straight to RDAP, which is how they get banned on their first real list.
//
// What it is NOT: proof. A name with no NS records may still be registered and simply parked
// without delegation, so `none` means "worth asking the registry", never "free".

import { Resolver } from "node:dns/promises";

export type DnsOutcome =
  /** NS records exist. The name is delegated, therefore registered. No registry query needed. */
  | "delegated"
  /** Authoritative "this name does not exist". Strongest free-ish signal DNS can give. */
  | "nxdomain"
  /** Resolves, but no NS — parked, or a resolver that answers oddly. Ask the registry. */
  | "no_records"
  /** Timeout, SERVFAIL, resolver unreachable. Says nothing about the domain. */
  | "unknown";

export interface DnsCheck {
  outcome: DnsOutcome;
  /** True only for `delegated`. Written to `DropCandidate.dnsHasRecords`. */
  hasRecords: boolean;
  /** Delegated nameservers, lower-cased, when we got any. */
  nameServers: string[];
  error?: string;
}

/**
 * Node's DNS error codes to an outcome. Split out from the I/O so the interesting part — which
 * failures mean "not registered" and which mean "we learned nothing" — is testable without a
 * network, and so a new code cannot silently fall into the wrong bucket.
 *
 * The distinction that matters: `NXDOMAIN` is an authoritative answer, while `SERVFAIL`,
 * `TIMEOUT` and `ECONNREFUSED` are the resolver failing. Folding the second group into the
 * first would mark thousands of live domains as candidates every time a resolver hiccups.
 */
export function classifyDnsError(code: string | undefined): DnsOutcome {
  switch (code) {
    case "ENOTFOUND":
    case "NXDOMAIN":
      return "nxdomain";
    case "ENODATA":
      // The name exists in the tree but holds no NS of its own — a subdomain, or a zone served
      // without delegation. Registered until the registry says otherwise.
      return "no_records";
    default:
      return "unknown";
  }
}

/** Whether this outcome lets us skip the registry entirely. Only delegation does. */
export function settlesWithoutRegistry(outcome: DnsOutcome): boolean {
  return outcome === "delegated";
}

/**
 * Should this candidate go on to the registry stage?
 *
 * `unknown` returns true on purpose. A resolver timeout must not quietly retire a candidate —
 * that is a silent data-loss bug that looks exactly like "this list had nothing in it".
 */
export function needsRegistryCheck(outcome: DnsOutcome): boolean {
  return outcome !== "delegated";
}

export interface DnsOptions {
  /** Resolvers to ask. Defaults to the system's. */
  servers?: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** One domain's delegation status. Never throws — every failure becomes an outcome. */
export async function checkDns(domain: string, opts: DnsOptions = {}): Promise<DnsCheck> {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, tries: 2 });
  if (opts.servers?.length) resolver.setServers(opts.servers);

  try {
    const ns = await resolver.resolveNs(domain);
    const nameServers = [...new Set(ns.map(h => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
    if (nameServers.length) {
      return { outcome: "delegated", hasRecords: true, nameServers };
    }
    // An empty NS array is not delegation, whatever the call's success suggests.
    return { outcome: "no_records", hasRecords: false, nameServers: [] };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const outcome = classifyDnsError(code);
    return {
      outcome,
      hasRecords: false,
      nameServers: [],
      error: code ?? (e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * A batch, with a bounded number of lookups in flight.
 *
 * Concurrency is capped rather than unbounded because a resolver answers a 50 000-domain flood
 * with SERVFAIL, and every one of those comes back `unknown` — which sends the whole list on to
 * the registry stage and undoes the entire point of running this first.
 */
export async function checkDnsBatch(
  domains: string[],
  opts: DnsOptions & { concurrency?: number; onResult?: (domain: string, res: DnsCheck) => void } = {},
): Promise<Map<string, DnsCheck>> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 20, 100));
  const out = new Map<string, DnsCheck>();
  let cursor = 0;

  async function worker() {
    while (cursor < domains.length) {
      const domain = domains[cursor++];
      const res = await checkDns(domain, opts);
      out.set(domain, res);
      opts.onResult?.(domain, res);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return out;
}
