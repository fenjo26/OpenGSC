// What an MCP credential may do, independent of who it belongs to.
//
// The workspace role says what a PERSON may do. A credential can be narrower than its person,
// and two kinds are:
//
//   - the main token arriving in the URL (`?token=`). Claude Desktop's connector dialog has no
//     header field, so for years the main token went into a URL — and a URL is the credential
//     that ends up in access logs, browser history, connector configs, screenshots and support
//     chats. Sent that way it now reads and runs free actions only (`read`, `act`).
//   - a connector link (McpLink): a separate token made for one client, read + free actions by
//     default, with publishing and spending switched on per link by the owner. Revoking one does
//     not break the others or the main token.
//
// The main token in an Authorization header keeps the person's full capabilities.
//
// Pure: no Prisma, no request — the route and the tests share it.

import type { Capability } from "@/lib/team/roles";

export const MAIN_TOKEN_PREFIX = "ogsc_";
export const LINK_TOKEN_PREFIX = "ogsc_link_";

/**
 * Shape checks. Every token ever minted is a prefix plus 48 lowercase hex characters, so anything
 * else — above all a stored hash form (`ogsc_1a2b…:sha256:…`) lifted from a database copy — is
 * refused before any lookup. Without this, the legacy-plaintext branch of the lookup would compare
 * a stolen hash form to itself and accept it.
 */
export function isLinkTokenFormat(token: string): boolean {
  return /^ogsc_link_[0-9a-f]{48}$/.test(token);
}

export function isMainTokenFormat(token: string): boolean {
  return /^ogsc_[0-9a-f]{48}$/.test(token);
}

export type TokenGrant =
  | { kind: "header" }
  | { kind: "url" }
  | { kind: "link"; linkId: string; allowWrite: boolean; allowSpend: boolean };

const FREE: readonly Capability[] = ["read", "act"];

/** The capabilities a credential carries: the person's, cut down to what the credential allows. */
export function grantCapabilities(grant: TokenGrant, person: readonly Capability[]): Capability[] {
  if (grant.kind === "header") return [...person];
  const allowed = new Set<Capability>(FREE);
  if (grant.kind === "link") {
    if (grant.allowWrite) allowed.add("write");
    if (grant.allowSpend) { allowed.add("spend"); allowed.add("publish"); }
  }
  return person.filter(c => allowed.has(c));
}

/** Minimal tool shape this module needs (McpTool satisfies it). */
export interface ScopedTool {
  cost: string;
  readOnly?: boolean;
  capability?: Capability;
}

/**
 * Every capability a call needs. A paid tool that also changes something (publish_post) needs
 * both `spend` and `write`; a single derived value let either one stand in for the other.
 */
export function requiredCapabilities(tool: ScopedTool): Capability[] {
  const need = new Set<Capability>(["read"]);
  if (tool.cost === "paid") need.add("spend");
  if (tool.readOnly === false) need.add("write");
  if (tool.capability) need.add(tool.capability);
  return [...need];
}

/**
 * Why a call is refused, or null. Distinguishes "your role cannot" from "this credential
 * cannot", because the fix differs: one is the owner's decision, the other is a settings toggle.
 */
export function refusal(
  toolName: string,
  tool: ScopedTool,
  role: string,
  person: readonly Capability[],
  grant: TokenGrant,
): string | null {
  const effective = grantCapabilities(grant, person);
  for (const cap of requiredCapabilities(tool)) {
    if (effective.includes(cap)) continue;
    if (!person.includes(cap)) return `This workspace role (${role}) may not call ${toolName}. Required: ${cap}.`;
    if (grant.kind === "url") {
      return `${toolName} needs "${cap}", and a token sent in the URL only reads and runs free actions — a URL ends up in logs and screenshots. ` +
        `In OpenGSC → Settings → API & MCP, create a connector link that allows ${cap === "write" ? "changes" : "publishing and spending"}, ` +
        `or send the token in an "Authorization: Bearer" header instead.`;
    }
    return `${toolName} needs "${cap}", which this connector link does not allow. ` +
      `The owner can create a link that allows ${cap === "write" ? "changes" : "publishing and spending"} in OpenGSC → Settings → API & MCP.`;
  }
  return null;
}

// ─── usage tracking ─────────────────────────────────────────────────────────────

export const KNOWN_IPS_MAX = 32;

/**
 * The subnet an address is remembered by: IPv4 /24, IPv6 /64. Hosted MCP clients egress
 * from published ranges whose host bits rotate on every call (claude.ai rotates inside
 * 160.79.104.0/21 and 153.61.208.0/20), so exact-address comparison flags nearly every
 * call as "new" (#41). The /24·/64 grain absorbs that rotation — a whole /21 is at most
 * 8 entries — while a genuinely different network still alerts. Residential ISP rotation
 * inside one /24 is quieter for humans too.
 */
export function subnetOf(ip: string): string {
  if (!ip) return "";
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — compare as the plain IPv4 address it is.
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const plain = mapped ? mapped[1] : ip;
  if (plain.includes(":")) {
    // Expand "::" into the missing zero groups, then keep the first four groups (/64).
    const halves = plain.split("::");
    if (halves.length === 2) {
      const head = halves[0] ? halves[0].split(":") : [];
      const tail = halves[1] ? halves[1].split(":") : [];
      const missing = 8 - head.length - tail.length;
      return [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail].slice(0, 4).join(":");
    }
    return plain.split(":").slice(0, 4).join(":");
  }
  const parts = plain.split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : plain;
}

/**
 * Alert when a credential that already has a history shows up from a network it never
 * used. `knownIps` keeps exact addresses (latest per subnet); the comparison is by subnet.
 */
export function isNewIp(knownIps: readonly string[], ip: string): boolean {
  if (ip === "unknown" || !ip || knownIps.length === 0) return false;
  const subnet = subnetOf(ip);
  return !knownIps.some(known => subnetOf(known) === subnet);
}

/**
 * The known-address list after a use: most recent first, bounded, ONE ENTRY PER SUBNET —
 * a fresh address replaces the older entry from its own /24 or /64. Exact-address
 * entries would churn the whole list under rotation (one slot per call), evict subnets
 * that were already seen and re-alert on them forever; the published claude.ai ranges
 * alone span 24 subnets, more than the old 20 slots could ever hold.
 */
export function rememberIp(knownIps: readonly string[], ip: string): string[] {
  if (!ip || ip === "unknown") return [...knownIps];
  const subnet = subnetOf(ip);
  return [ip, ...knownIps.filter(known => subnetOf(known) !== subnet)].slice(0, KNOWN_IPS_MAX);
}

export function parseKnownIps(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string").slice(0, KNOWN_IPS_MAX);
  if (typeof raw !== "string" || !raw) return [];
  try { return parseKnownIps(JSON.parse(raw)); } catch { return []; }
}
