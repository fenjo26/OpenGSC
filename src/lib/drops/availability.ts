// "Is this name registered?" — the stage the whole module exists to reach.
//
// Two sources, asked in a fixed order: RDAP (structured, fast, rate-limited) and then WHOIS
// (text, slower, the only option in several zones). Which of them a zone gets, and how fast we
// may ask, comes from its `RegistryProfile` rather than from a flat table here.
//
// The rule that shapes everything below: **a single source saying "free" is not an answer.** An
// RDAP 404 is returned by `rdap.org` for a name that is genuinely unregistered, for a TLD it
// cannot route, and by some registry endpoints on their own internal errors. So a 404 sends the
// question to WHOIS, and only agreement sets `corroborated`. Callers must never alert, buy, or
// paint a row green on an uncorroborated `available`.
//
// Derived in part from BigDesigner/project-backorder (MIT).

import { safeFetch } from "@/lib/security/safeFetch";
import { parseWhoisAvailability, parseWhoisCreated, parseWhoisExpiry, parseWhoisNameServers, parseWhoisStatuses } from "./patterns";
import { profileForDomain, type RegistryProfile } from "./registries";
import { WhoisError, discoverWhoisHost, whoisQuery } from "./whois";
import type { AvailabilityResult } from "./types";

const RDAP_TIMEOUT_MS = 12_000;
const RDAP_MAX_BYTES = 512 * 1024;
const USER_AGENT = "OpenGSC-Drops/1.0 (+https://github.com/fenjo26/OpenGSC)";

/**
 * Only letters, digits, hyphen and dot ever reach a URL.
 *
 * The domain is concatenated into an RDAP endpoint, so a row containing `../` or a second host
 * would make this server fetch an address the list author chose. `ingest.ts` already rejects such
 * rows, but this function is also reachable from the scheduler and from any future caller, and a
 * guard that only exists upstream is a guard that will one day be bypassed.
 */
export function sanitiseForUrl(domain: string): string {
  return domain.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "");
}

/** Jitter before a registry call: identical-interval traffic is the easiest pattern to throttle. */
function jitter(): Promise<void> {
  return new Promise(r => setTimeout(r, 100 + Math.random() * 900));
}

interface RdapOutcome {
  kind: "registered" | "absent" | "rate_limited" | "unusable";
  http: number;
  retryAfterSec?: number;
  expiresAt?: Date;
  createdAt?: Date;
  registryStatus?: string[];
  nameServers?: string[];
  registrar?: string;
}

/**
 * RDAP is deliberately allowed to answer "unusable".
 *
 * A 500 from a registry endpoint and a 404 from a bootstrap redirector carry no information about
 * the domain, and collapsing either into a verdict is how a checker reports live domains as free.
 */
async function askRdap(domain: string, profile: RegistryProfile): Promise<RdapOutcome> {
  if (!profile.rdap) return { kind: "unusable", http: 0 };
  const base = profile.rdap.endsWith("/") ? profile.rdap : `${profile.rdap}/`;

  try {
    const res = await safeFetch(`${base}${sanitiseForUrl(domain)}`, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": USER_AGENT },
      timeoutMs: RDAP_TIMEOUT_MS,
      maxBytes: RDAP_MAX_BYTES,
      // A public registry is a public host. Nothing here should reach a private address, and
      // saying so explicitly keeps this call unaffected by the instance-wide opt-out.
      allowPrivate: false,
    });

    if (res.status === 404) return { kind: "absent", http: 404 };
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "rate_limited", http: 429, retryAfterSec: Number.isFinite(ra) ? ra : undefined };
    }
    if (!res.ok) return { kind: "unusable", http: res.status };

    const body = await res.json<Record<string, unknown>>();
    // Defensive throughout: RDAP shapes vary by registry and a missing array must not throw.
    const events = Array.isArray(body?.events) ? (body.events as Record<string, unknown>[]) : [];
    const dateFor = (action: string) => {
      const hit = events.find(e => String(e?.eventAction ?? "") === action);
      const t = hit ? Date.parse(String(hit.eventDate ?? "")) : NaN;
      return Number.isNaN(t) ? undefined : new Date(t);
    };
    const nameservers = Array.isArray(body?.nameservers) ? (body.nameservers as Record<string, unknown>[]) : [];

    return {
      kind: "registered",
      http: res.status,
      expiresAt: dateFor("expiration"),
      createdAt: dateFor("registration"),
      registryStatus: Array.isArray(body?.status) ? (body.status as string[]).map(String) : [],
      nameServers: nameservers.map(n => String(n?.ldhName ?? "").toLowerCase()).filter(Boolean),
    };
  } catch {
    // Network failure, DNS failure, body too large — none of them say anything about the domain.
    return { kind: "unusable", http: 0 };
  }
}

interface WhoisOutcome {
  kind: "registered" | "absent" | "refused" | "unusable";
  expiresAt?: Date;
  createdAt?: Date;
  registryStatus?: string[];
  nameServers?: string[];
}

async function askWhois(domain: string, profile: RegistryProfile): Promise<WhoisOutcome> {
  const host = profile.whoisHost ?? (await discoverWhoisHost(profile.tld));
  if (!host) return { kind: "unusable" };

  let raw: string;
  try {
    raw = await whoisQuery(host, domain);
  } catch (e) {
    // A timeout is a refusal in disguise often enough that treating it as "no information" is the
    // only safe reading — see the four-way verdict in patterns.ts.
    return { kind: e instanceof WhoisError ? "unusable" : "unusable" };
  }

  const verdict = parseWhoisAvailability(raw, profile);
  if (verdict === "available") return { kind: "absent" };
  if (verdict === "refused") return { kind: "refused" };
  if (verdict === "empty") return { kind: "unusable" };

  return {
    kind: "registered",
    expiresAt: parseWhoisExpiry(raw) ?? undefined,
    createdAt: parseWhoisCreated(raw) ?? undefined,
    registryStatus: parseWhoisStatuses(raw),
    nameServers: parseWhoisNameServers(raw),
  };
}

/**
 * The verdict for one domain.
 *
 * The order of the branches is the contract:
 *
 * - RDAP says registered  → registered, done. Nothing contradicts a record that exists.
 * - RDAP says 404         → ask WHOIS. Agreement gives `corroborated: true`; WHOIS saying
 *                           "registered" wins (a record beats an absence); anything else gives
 *                           `available` with `corroborated: false`, which is a prompt to look
 *                           again, not a green row.
 * - RDAP unusable/absent  → WHOIS alone decides, and can never corroborate itself.
 * - Both rate-limited     → `rate_limited`, so the caller backs off instead of recording a
 *                           verdict it did not get.
 */
export async function checkAvailability(domain: string): Promise<AvailabilityResult> {
  const profile = profileForDomain(domain);
  if (!profile) return { ok: false, status: "error", http: 0, error: "not_a_domain" };

  await jitter();
  const rdap = await askRdap(domain, profile);

  if (rdap.kind === "registered") {
    return {
      ok: true, status: "registered", http: rdap.http, via: "rdap",
      expiresAt: rdap.expiresAt, createdAt: rdap.createdAt,
      registryStatus: rdap.registryStatus, nameServers: rdap.nameServers, registrar: rdap.registrar,
    };
  }
  if (rdap.kind === "rate_limited") {
    return { ok: false, status: "rate_limited", http: 429, retryAfterSec: rdap.retryAfterSec };
  }

  const whois = await askWhois(domain, profile);

  if (whois.kind === "registered") {
    return {
      ok: true, status: "registered", http: 200, via: "whois",
      expiresAt: whois.expiresAt, createdAt: whois.createdAt,
      registryStatus: whois.registryStatus, nameServers: whois.nameServers,
    };
  }
  if (whois.kind === "absent") {
    return {
      ok: true, status: "available", http: rdap.http || 200, via: rdap.kind === "absent" ? "rdap" : "whois",
      // Corroborated only when RDAP independently returned 404 as well.
      corroborated: rdap.kind === "absent",
    };
  }
  if (whois.kind === "refused") {
    return { ok: false, status: "rate_limited", http: 429 };
  }

  // WHOIS gave nothing usable. If RDAP said 404 we have exactly one weak signal, and it is
  // reported as such rather than thrown away — a zone with no working WHOIS would otherwise never
  // produce a candidate at all.
  if (rdap.kind === "absent") {
    return { ok: true, status: "available", http: 404, via: "rdap", corroborated: false };
  }
  return { ok: false, status: "error", http: rdap.http, error: "no_usable_source" };
}

/**
 * A batch, serialised **per registry**.
 *
 * Throttling is per registry rather than per domain because that is how the limits are actually
 * enforced: 500 `.com` and 500 `.de` can run side by side, 200 sequential `.com` cannot. Domains
 * are therefore grouped by zone, each zone is walked in order with its own `minIntervalMs`, and
 * the zones run in parallel. Doing it any other way either wastes hours or earns a ban.
 */
export async function checkAvailabilityBatch(
  domains: string[],
  opts: { onResult?: (domain: string, res: AvailabilityResult) => void } = {},
): Promise<Map<string, AvailabilityResult>> {
  const out = new Map<string, AvailabilityResult>();
  const byZone = new Map<string, string[]>();

  for (const domain of domains) {
    const profile = profileForDomain(domain);
    const key = profile?.tld ?? "";
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key)!.push(domain);
  }

  await Promise.all([...byZone.entries()].map(async ([tld, list]) => {
    const interval = tld ? (profileForDomain(list[0])?.minIntervalMs ?? 3000) : 0;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, interval));
      const res = await checkAvailability(list[i]);
      out.set(list[i], res);
      opts.onResult?.(list[i], res);
      // A registry that starts refusing will refuse the rest of its own queue too. Stopping this
      // zone leaves the others running instead of burning the whole batch against one bad host.
      if (!res.ok && res.status === "rate_limited") break;
    }
  }));

  return out;
}
