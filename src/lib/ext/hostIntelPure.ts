// wave-ext E5 — pure helpers behind /api/ext/hosts. No Prisma, no Date.now: everything here is
// unit-tested in hostIntel.test.ts and reusable by the capture flow.

import { hostOfUrl } from "@/lib/serpmon/hosts";
import { apexOf } from "@/lib/drops/registries";

/** Normalise client-supplied host strings: a bare host gets an "https://" prefix first (hostOfUrl
 *  needs a full URL), then hostOfUrl → dedupe → keep request order → cap at `max`. */
export function normaliseHosts(raw: unknown[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const asStr = String(entry ?? "").trim();
    if (!asStr) continue;
    const withScheme = /^https?:\/\//i.test(asStr) ? asStr : `https://${asStr}`;
    const host = hostOfUrl(withScheme);
    if (!host) continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

interface DrSource {
  dr: number | null;
  at: Date | null;
}

/** The freshest non-null DR of the three sources; ties resolve serpmon > metric > dr_cache. */
export function pickDr(c: {
  serpmon?: DrSource | null;
  metric?: DrSource | null;
  drCache?: DrSource | null;
}): { dr: number | null; source: "serpmon" | "metric_cache" | "dr_cache" | null; at: Date | null } {
  const order: { key: "serpmon" | "metric" | "drCache"; source: "serpmon" | "metric_cache" | "dr_cache" }[] = [
    { key: "serpmon", source: "serpmon" },
    { key: "metric", source: "metric_cache" },
    { key: "drCache", source: "dr_cache" },
  ];
  let best: { dr: number; source: "serpmon" | "metric_cache" | "dr_cache"; at: Date | null } | null = null;
  for (const cand of order) {
    const v = c[cand.key];
    if (!v || v.dr == null) continue;
    const at = v.at ?? new Date(0);
    if (!best || at > (best.at ?? new Date(0))) best = { dr: v.dr, source: cand.source, at: v.at };
  }
  return best ? { dr: best.dr, source: best.source, at: best.at } : { dr: null, source: null, at: null };
}

/** Order a user's SERP Monitor projects for one host: projects matching the query's country/lang
 *  first (an unknown country or lang matches everything — the server then does not narrow),
 *  then by tracked-keyword count, capped. */
export function rankProjects<T extends { country: string; lang: string; keywords: number }>(rows: T[], country: string, lang: string, max: number): T[] {
  const wantCountry = country.trim().toLowerCase();
  const wantLang = lang.trim().toLowerCase();
  const matches = (p: T): boolean =>
    (!wantCountry || !p.country || p.country.toLowerCase() === wantCountry) &&
    (!wantLang || !p.lang || p.lang.toLowerCase() === wantLang);
  return rows
    .slice()
    .sort((a, b) => {
      const ma = matches(a) ? 0 : 1;
      const mb = matches(b) ? 0 : 1;
      return ma - mb || b.keywords - a.keywords;
    })
    .slice(0, max);
}

/** Impression-weighted average position, 1 decimal; null when there are no impressions. */
export function weightedPosition(rows: { impressions: number; position: number }[]): number | null {
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    impressions += Math.max(0, r.impressions);
    weighted += Math.max(0, r.impressions) * r.position;
  }
  if (!impressions) return null;
  return Math.round((weighted / impressions) * 10) / 10;
}

/** apexOf(a) === apexOf(b); null-safe — unknown apexes never compare equal (except both empty). */
export function sameApex(a: string, b: string): boolean {
  const ra = apexOf(a);
  const rb = apexOf(b);
  if (ra == null || rb == null) return false;
  return ra === rb;
}
