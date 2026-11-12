// Event types for operator notes (Annotation.eventType) and the URL-prefix rules for moves.
//
// Pure module: no Prisma, no fetch — shared by the annotations route, the site page and tests.
//
// A move inside ONE Search Console property (a folder, or a subdomain when the property is a
// `sc-domain:` one) is scored here by URL prefix. A move between properties — another domain, or a
// subdomain that is its own URL-prefix property — is two sites, and belongs to the cross-site move
// model (see claude/site-moves-plan.md, E3); `checkPrefixInProperty` is what tells the two apart.

export const EVENT_TYPES = [
  "note",
  "content_update",
  "title_meta",
  "redesign",
  "redirect",
  "folder_move",
  "subdomain_move",
  "domain_move",
  "links",
  "tech",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** One colour per type. Purchases (#7C3AED) and Google updates keep their own palettes, so none of
 *  these reuse them. "note" stays the neutral grey it has always been. */
export const EVENT_COLORS: Record<EventType, string> = {
  note: "#6B7280",
  content_update: "#10B981",
  title_meta: "#0EA5E9",
  redesign: "#EC4899",
  redirect: "#F59E0B",
  folder_move: "#EF4444",
  subdomain_move: "#DC2626",
  domain_move: "#B91C1C",
  links: "#8B5CF6",
  tech: "#64748B",
};

/** Moves scored by URL prefix inside one property. domain_move is not here on purpose: another
 *  domain is another property, so there is nothing in this site's DailyMetric to score it with. */
export const PREFIX_MOVE_TYPES: readonly EventType[] = ["folder_move", "subdomain_move"];

export function normalizeEventType(v: unknown): EventType {
  return (EVENT_TYPES as readonly string[]).includes(String(v)) ? (v as EventType) : "note";
}

export function isPrefixMove(t: EventType | string | null | undefined): boolean {
  return PREFIX_MOVE_TYPES.includes(t as EventType);
}

/**
 * Canonical form of a move prefix: absolute http(s) URL, lower-case host, no query or fragment,
 * path ending in "/". The trailing slash matters — without it `/old` would also match `/older/`,
 * and a move would silently swallow an unrelated folder. Returns null when it is not a URL.
 */
export function normalizePrefix(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null;
  let path = u.pathname || "/";
  if (!path.endsWith("/")) path += "/";
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}${path}`;
}

/** Escapes LIKE wildcards with "!" — portable: "\" is an escape inside MySQL string literals but a
 *  plain character in SQLite, so a backslash ESCAPE behaves differently on the two engines. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[!%_]/g, c => `!${c}`)}%`;
}

const stripWww = (h: string) => h.replace(/^www\./, "");

/**
 * Whether a prefix's data can live in this site's Search Console property.
 *
 *   sc-domain:example.com      → example.com and every subdomain of it
 *   https://example.com/       → only URLs under that exact prefix
 *
 * "outside" means the move crosses properties — the UI says to link two sites instead (E3).
 */
export function checkPrefixInProperty(prefix: string, gscProperty: string): "ok" | "outside" {
  const p = String(gscProperty || "").trim();
  if (/^sc-domain:/i.test(p)) {
    const root = p.replace(/^sc-domain:/i, "").toLowerCase().replace(/\.$/, "");
    let host: string;
    try { host = new URL(prefix).hostname.toLowerCase(); } catch { return "outside"; }
    return host === root || host.endsWith(`.${root}`) ? "ok" : "outside";
  }
  const base = normalizePrefix(p);
  if (!base) return "outside";
  if (prefix.startsWith(base)) return "ok";
  // http vs https and www vs bare are the same property in practice only if GSC says so — it does
  // not, so the only leniency is the protocol the operator might have typed by habit.
  const swap = (x: string) => x.replace(/^https?:\/\//, "");
  return swap(prefix).startsWith(swap(base)) ? "ok" : "outside";
}

/** Suggests the move type from the two prefixes: same host → folder, different host → subdomain. */
export function inferMoveType(from: string, to: string): "folder_move" | "subdomain_move" {
  try {
    return stripWww(new URL(from).hostname) === stripWww(new URL(to).hostname) ? "folder_move" : "subdomain_move";
  } catch {
    return "folder_move";
  }
}
