// Dynadot — a registrar asked as a second opinion, never as the first.
//
// Why a registrar belongs in a module built on registries at all. RDAP and WHOIS answer "is
// there a record for this name". A registrar answers a different question — "can I sell you this
// name" — and the gap between the two is exactly where a drop hunter loses money:
//
//   • a name with no registry record can still be reserved by the registry, or priced as a
//     premium at several thousand dollars. Both are "free" to RDAP and neither is buyable at the
//     price the funnel assumes;
//   • conversely a registrar's "unavailable" is not evidence of registration. It can mean
//     reserved, premium, on the registrar's own blocklist, or simply a zone it does not carry.
//
// So the contract here is deliberately asymmetric, and it is the whole design:
//
//   **Dynadot may confirm `available`. It may never turn `available` into `taken`.**
//
// Getting that backwards would trade the module's rare false "free" for a steady stream of false
// "taken", which is worse: a false "free" costs one wasted check, a false "taken" silently drops
// a good domain out of the funnel and nobody ever finds out.
//
// Credentials: user-supplied, never bundled. This is an open-source app that other people run on
// their own servers, so there is nothing here to hardcode and no shared account to leak — the
// key comes from the instance's environment or from that instance owner's own settings.

import { safeFetch } from "@/lib/security/safeFetch";
import { sanitiseForUrl } from "./registries";
import type { RegistrarConfirmer } from "./types";

/**
 * The legacy `api3` search endpoint, not the RESTful v1/v2 one, and the choice is deliberate.
 *
 * Dynadot's current API requires an `X-Signature` HMAC over the request for *transactional*
 * calls. Availability is not transactional, and `api3` answers it with the API key alone — so
 * asking "is this name free" never needs the secret that can also spend money. Registration,
 * when it is built, is the opposite case and will need the signed API and its own guard rails.
 */
const BASE = "https://api.dynadot.com/api3.json";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;

/**
 * One request per second.
 *
 * Dynadot's documented ceiling on a regular account is 60 requests per minute with a single
 * thread; the bulk tiers that allow batching are tied to account spend and cannot be assumed.
 * This stage only ever sees the short list that survived DNS and the registry, so a serial
 * one-per-second walk is not a constraint worth engineering around.
 */
const MIN_INTERVAL_MS = 1_000;

export interface DynadotCreds {
  apiKey: string;
}

/**
 * The verdict, kept wider than a boolean on purpose.
 *
 * "Not for sale" and "already registered" are different facts and the caller treats them
 * differently. Collapsing them is how a premium name ends up recorded as taken.
 */
export type DynadotVerdict =
  /** Dynadot will sell it at a standard price. */
  | "available"
  /** Dynadot will sell it, but not at a standard price — premium or aftermarket. */
  | "premium"
  /** Dynadot will not sell it: registered, reserved, blocked, or a zone it does not carry. */
  | "unavailable"
  /** Rate limit, auth failure, transport error — no information about the domain. */
  | "refused"
  /** A 200 we could not read. Never a verdict. */
  | "unknown";

export interface DynadotOutcome {
  verdict: DynadotVerdict;
  /** Listed price when the answer carried one, for the premium case. */
  price?: string;
  /** The service's own words, for the UI and the event log. Never contains the key. */
  reason?: string;
}

/** Serialises calls and spaces them. Module-level: the limit is per account, not per batch. */
let nextSlotAt = 0;
async function slot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/**
 * Find the result object in the response, whichever envelope this account's API version returns.
 *
 * Written as a walk rather than a fixed path because the shape is the one thing here that could
 * not be verified against a live account before shipping — the documented fields (`DomainName`,
 * `Available`, `Price`, `Error`) are stable across Dynadot's versions, the wrapper around them is
 * not. A walk that looks for those fields survives the wrapper changing; a hardcoded
 * `body.SearchResponse.SearchResults[0]` becomes a silent `unknown` the day it does.
 */
export function findResultNode(body: unknown, domain: string): Record<string, unknown> | null {
  const target = domain.trim().toLowerCase();
  const seen = new Set<unknown>();
  const stack: unknown[] = [body];
  let fallback: Record<string, unknown> | null = null;

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    const availableKey = keys.find(k => k.toLowerCase() === "available");
    if (availableKey) {
      const nameKey = keys.find(k => k.toLowerCase() === "domainname" || k.toLowerCase() === "domain");
      const name = nameKey ? String(obj[nameKey] ?? "").trim().toLowerCase() : "";
      // An exact name match wins outright. Without one we keep the first node that at least
      // carries an availability field, because a single-domain search may not echo the name.
      if (name && name === target) return obj;
      if (!fallback) fallback = obj;
    }
    stack.push(...Object.values(obj));
  }
  return fallback;
}

/** Reads one result node into a verdict. Pure, so every branch below is testable offline. */
export function readVerdict(node: Record<string, unknown> | null): DynadotOutcome {
  if (!node) return { verdict: "unknown", reason: "no_result_node" };

  const keys = Object.keys(node);
  const get = (want: string) => {
    const k = keys.find(x => x.toLowerCase() === want);
    return k ? String(node[k] ?? "").trim() : "";
  };

  const error = get("error");
  if (error) return { verdict: "refused", reason: error.slice(0, 200) };

  const available = get("available").toLowerCase();
  const price = get("price");
  const status = get("status").toLowerCase();

  // Premium first: a premium name answers "yes" to availability and is still not the thing the
  // funnel thinks it found. Dynadot has spelled this differently across versions, so the test is
  // on the words rather than on one field name.
  const looksPremium =
    keys.some(k => k.toLowerCase().includes("premium")) ||
    status.includes("premium") ||
    available.includes("premium");

  if (available === "yes" || available === "true") {
    return looksPremium
      ? { verdict: "premium", price: price || undefined, reason: "registrar offers this as a premium name" }
      : { verdict: "available", price: price || undefined };
  }
  if (available === "no" || available === "false") {
    return { verdict: "unavailable", reason: status || "registrar will not sell this name" };
  }
  // Anything else is a shape we do not understand, and guessing is the one thing this module
  // must not do — see the asymmetry at the top of the file.
  return { verdict: "unknown", reason: `unreadable availability: ${available.slice(0, 60) || "(empty)"}` };
}

export interface DynadotRaw {
  outcome: DynadotOutcome;
  /** The untouched response, for the settings "check connection" button only. Never logged. */
  raw?: unknown;
}

/**
 * Ask Dynadot about one name.
 *
 * `keepRaw` exists for the connection test in Settings and nowhere else: the response envelope
 * could not be pinned against a live account from here, so the first thing an operator does is
 * look at it. It is returned to that one screen and never written anywhere.
 */
export async function dynadotSearch(
  domain: string,
  creds: DynadotCreds,
  opts: { keepRaw?: boolean; currency?: string } = {},
): Promise<DynadotRaw> {
  const key = String(creds?.apiKey ?? "").trim();
  if (!key) return { outcome: { verdict: "refused", reason: "no_key" } };

  await slot();

  const params = new URLSearchParams({
    key,
    command: "search",
    domain0: sanitiseForUrl(domain),
    show_price: "1",
    currency: opts.currency || "USD",
  });

  let res;
  try {
    res = await safeFetch(`${BASE}?${params.toString()}`, {
      headers: { accept: "application/json" },
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      allowPrivate: false,
    });
  } catch {
    // The key is in the query string, so nothing derived from the request may reach a message.
    return { outcome: { verdict: "refused", reason: "network" } };
  }

  if (res.status === 429) return { outcome: { verdict: "refused", reason: "rate_limited" } };
  if (res.status === 401 || res.status === 403) return { outcome: { verdict: "refused", reason: "bad_key" } };
  if (!res.ok) return { outcome: { verdict: "refused", reason: `http_${res.status}` } };

  let body: unknown;
  try {
    body = await res.json<unknown>();
  } catch {
    return { outcome: { verdict: "unknown", reason: "non_json" } };
  }

  const outcome = readVerdict(findResultNode(body, domain));
  return opts.keepRaw ? { outcome, raw: body } : { outcome };
}

/**
 * Where the key comes from, in priority order.
 *
 * The environment wins, because a self-hosted instance run by one operator should be able to
 * configure this once in `.env` and never put a credential through a browser. Below that sits the
 * instance owner's own settings, mirrored to the server the same way every other provider key in
 * this app is — writing it is owner-only (`manageSecrets`), which is what makes a per-instance
 * key safe in a multi-member workspace.
 *
 * Nothing is bundled and nothing is shared. This project is run by other people on their own
 * servers with their own Dynadot accounts; a key in the repository would be both a leak and a
 * bill somebody else pays.
 */
export function dynadotCreds(settings?: Record<string, unknown> | null): DynadotCreds | null {
  const fromEnv = (process.env.DYNADOT_API_KEY ?? "").trim();
  const fromSettings = String(settings?.seoKey_dynadot ?? "").trim();
  const apiKey = fromEnv || fromSettings;
  return apiKey ? { apiKey } : null;
}

/** The registry checker's view of Dynadot: a name and one question. */
export function dynadotConfirmer(creds: DynadotCreds): RegistrarConfirmer {
  return {
    name: "Dynadot",
    async confirm(domain: string) {
      const { outcome } = await dynadotSearch(domain, creds);
      return { verdict: outcome.verdict, reason: outcome.reason, price: outcome.price };
    },
  };
}
