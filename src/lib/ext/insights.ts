// wave-ext E2 — the panel's OpenGSC tab beyond GET /api/ext/page: the main GSC query, sitemap
// membership, free meta fit and the network-wide footprint check. E0 lays the signatures
// (CONTRACT/E2 §1); bodies land with E2.
import type { InsightsRequest, InsightsResponse, FootprintHit } from "./types";
import type { FootprintItem } from "@/lib/footprint";

/** Everything the panel's OpenGSC tab needs beyond GET /api/ext/page. DB-bound. */
export async function pageInsights(userId: string, req: InsightsRequest): Promise<InsightsResponse> {
  void userId; void req;
  throw new Error("not_implemented");
}

// ── pure (tested) ──

/** The page's main query: more clicks → more impressions → lower position → alphabetical. */
export function pickMainQuery(rows: { query: string; clicks: number; impressions: number; position: number }[]):
  { query: string; clicks: number; impressions: number; position: number } | null {
  void rows;
  throw new Error("not_implemented");
}

/** Footprint matches of this page's title/description/H1 skeletons against the rest of the
 *  portfolio (other identities only, short skeletons skipped, ≤ maxMatches per kind). */
export function footprintHits(
  page: { siteId: string; url: string; title: string; description: string; h1: string; entities: string[] },
  items: FootprintItem[],
  opts?: { threshold?: number; minWords?: number; maxMatches?: number },
): FootprintHit[] {
  void page; void items; void opts;
  throw new Error("not_implemented");
}
