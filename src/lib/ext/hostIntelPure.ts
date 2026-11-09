// wave-ext E5 — pure helpers behind /api/ext/hosts. E0 lays the signatures from the brief
// (CONTRACT/E5 §1); the bodies land with E5. Everything here must stay free of Prisma/DB so
// hostIntel.test.ts can run under node:test.

/** Normalise client-supplied host strings: bare hosts get an "https://" prefix (hostOfUrl needs
 *  a URL), then hostOfUrl → dedupe → keep request order → cap at `max`. */
export function normaliseHosts(raw: unknown[], max: number): string[] {
  void raw; void max;
  throw new Error("not_implemented");
}

/** The freshest non-null DR of the three sources; ties resolve serpmon > metric > dr_cache. */
export function pickDr(c: {
  serpmon?: { dr: number | null; at: Date | null } | null;
  metric?: { dr: number | null; at: Date | null } | null;
  drCache?: { dr: number | null; at: Date | null } | null;
}): { dr: number | null; source: "serpmon" | "metric_cache" | "dr_cache" | null; at: Date | null } {
  void c;
  throw new Error("not_implemented");
}

/** Order a user's SERP Monitor projects for one host: projects matching the query's country/lang
 *  first (unknown country/lang → all count as matching), then by tracked-keyword count. */
export function rankProjects<T extends { country: string; lang: string; keywords: number }>(rows: T[], country: string, lang: string, max: number): T[] {
  void rows; void country; void lang; void max;
  throw new Error("not_implemented");
}

/** Impression-weighted average position, 1 decimal; null when there are no impressions. */
export function weightedPosition(rows: { impressions: number; position: number }[]): number | null {
  void rows;
  throw new Error("not_implemented");
}

/** apexOf(a) === apexOf(b); null-safe (unknown apex → false unless both unknown). */
export function sameApex(a: string, b: string): boolean {
  void a; void b;
  throw new Error("not_implemented");
}
