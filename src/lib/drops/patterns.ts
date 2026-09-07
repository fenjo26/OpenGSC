// Reading a WHOIS reply. Pure string work — no sockets, no Prisma — so the interesting cases
// are covered by tests instead of by trying it against a live registry.
//
// Derived in part from BigDesigner/project-backorder (MIT), whose regex set had already been
// tuned against real registry replies.

import type { RegistryProfile } from "./registries";

/**
 * Phrasings that mean "this name is not registered". Anchored to line starts: the words also
 * appear mid-sentence in legal boilerplate ("...no match for the terms of use...") and an
 * unanchored match there would report a live domain as free.
 */
export const AVAILABLE_PATTERNS: RegExp[] = [
  /^no match for/im,
  /^no match found for/im,
  /^not found/im,
  /^%+\s*no entries found/im,
  /^no data found/im,
  /^domain not found/im,
  /^no object found/im,
  /^nothing found for this query/im,
  /^status:\s*(free|available|AVAILABLE)$/im,
  /^%\s*not registered/im,
  /^the queried object does not exist/im,
];

/**
 * Replies that carry no verdict at all: the registry refused, throttled, or asked for a captcha.
 * These must be reported as errors, never silently folded into "registered" — a rate-limit reply
 * contains none of the AVAILABLE_PATTERNS, so a naive reader calls every throttled name taken.
 */
export const REFUSAL_PATTERNS: RegExp[] = [
  /query rate|rate limit|too many requests|exceeded the maximum/i,
  // Line-anchored on purpose. Verisign's TERMS OF USE boilerplate — present on every reply,
  // "No match" and full records alike — says "You are not authorized to access or query our
  // Whois database" mid-sentence, and an unanchored match read every normal .com answer as a
  // refusal (phase 0, 2026-09-07). Registries that refuse put the words at a line start.
  /^\s*(access denied|not authorized|permission denied)/im,
  /temporarily unavailable|try again later|service unavailable/i,
  /captcha/i,
];

export type WhoisVerdict = "available" | "registered" | "refused" | "empty";

/**
 * The verdict for one WHOIS body. `refused` and `empty` are distinct from `registered` on
 * purpose: only a positive reading of the text may conclude a name is taken.
 */
export function parseWhoisAvailability(text: string, profile?: RegistryProfile): WhoisVerdict {
  const body = (text ?? "").trim();
  if (!body) return "empty";
  if (REFUSAL_PATTERNS.some(re => re.test(body))) return "refused";

  const extra = profile?.availablePatterns ?? [];
  if ([...extra, ...AVAILABLE_PATTERNS].some(re => re.test(body))) return "available";

  // A registered name always carries at least one of these. Without any of them we have a body
  // we do not understand, and guessing "registered" would hide a broken parser behind a
  // plausible answer for months.
  const hasRegistrationEvidence =
    /^\s*(domain name|domain|nserver|name server|registrar|registry domain id|creation date|created)/im.test(body);
  return hasRegistrationEvidence ? "registered" : "empty";
}

/** Registry expiry, if the reply carries one. Returns `null` rather than guessing. */
export function parseWhoisExpiry(text: string): Date | null {
  const patterns = [
    /registry expiry date\s*:\s*([^\r\n]+)/i,
    /(?:expiry|expiration) date\s*:\s*([^\r\n]+)/i,
    /^\s*expires?(?: on)?\s*:\s*([^\r\n]+)/im,
    /paid-till\s*:\s*([^\r\n]+)/i,
  ];
  return firstDate(text, patterns);
}

/** Registration date, used to tell a long-lived site from a name registered for a month. */
export function parseWhoisCreated(text: string): Date | null {
  const patterns = [
    /creation date\s*:\s*([^\r\n]+)/i,
    /^\s*created(?: on)?\s*:\s*([^\r\n]+)/im,
    /registered on\s*:\s*([^\r\n]+)/i,
  ];
  return firstDate(text, patterns);
}

function firstDate(text: string, patterns: RegExp[]): Date | null {
  for (const re of patterns) {
    const m = (text ?? "").match(re);
    if (!m?.[1]) continue;
    const t = Date.parse(m[1].trim());
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

/**
 * Name servers from the reply. This is the cheapest corroboration there is: a name with live
 * NS records is registered, whatever the prose says.
 */
export function parseWhoisNameServers(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/^\s*(?:name server|nserver|nameserver)\s*:\s*([^\r\n]+)/gim)) {
    const host = m[1].trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, "");
    if (host) out.add(host);
  }
  return [...out];
}

/** EPP statuses, e.g. "pendingDelete" / "redemptionPeriod" — what drives the fast re-check. */
export function parseWhoisStatuses(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/^\s*(?:domain )?status\s*:\s*([^\r\n]+)/gim)) {
    const value = m[1].trim().split(/\s+/)[0];
    if (value) out.add(value);
  }
  return [...out];
}

/** True when the registry statuses say the name is on its way out — re-check aggressively. */
export function isDroppingSoon(statuses: string[]): boolean {
  return statuses.some(s => /pending\s*delete|redemption/i.test(s));
}
