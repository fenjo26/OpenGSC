// The group "Купить" files bought domains into. Pure module (no Prisma) so the page, the route
// and the test share one table.
//
// The app ships in 8 languages and a group is just a named row, so the name is chosen by the
// interface language at the moment of the first purchase. Matching is the other half: an
// existing group under ANY of these names (or a common variant) is reused, so switching the
// interface language never spawns a second "bought" group next to the first.

export const ACQUIRED_GROUP_NAMES: Readonly<Record<string, string>> = {
  en: "Acquired",
  ru: "Куплено",
  uk: "Куплені",
  de: "Gekauft",
  es: "Comprados",
  fr: "Achetés",
  nl: "Gekocht",
  zh: "已购买",
};

/** Other spellings people actually type for the same folder — reused, never duplicated. */
const ALIASES = ["купленные", "куплены", "купленные домены", "bought", "purchased", "куплено"];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const KNOWN = new Set([...Object.values(ACQUIRED_GROUP_NAMES), ...ALIASES].map(norm));

/** Is this an existing group that already plays the "bought domains" role? */
export function isAcquiredGroupName(name: string): boolean {
  return KNOWN.has(norm(name));
}

/** The name to create the group under, for the interface language; English for anything else. */
export function acquiredGroupName(lang: string | null | undefined): string {
  return ACQUIRED_GROUP_NAMES[String(lang ?? "").toLowerCase()] ?? ACQUIRED_GROUP_NAMES.en;
}

/**
 * A client-sent name is only trusted if it is one of ours — the route never creates an
 * arbitrary group just because a request body asked for it.
 */
export function sanitizeAcquiredGroupName(name: unknown): string {
  if (typeof name === "string") {
    const hit = Object.values(ACQUIRED_GROUP_NAMES).find(v => norm(v) === norm(name));
    if (hit) return hit;
  }
  return ACQUIRED_GROUP_NAMES.en;
}

/** Pick the group to reuse: the oldest one whose name matches. */
export function pickAcquiredGroup<T extends { name: string; createdAt: Date | string }>(groups: T[]): T | null {
  const hits = groups.filter(g => isAcquiredGroupName(g.name));
  hits.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return hits[0] ?? null;
}
