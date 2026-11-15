// T3 — the domain's position in Common Crawl's web graph.
//
// Every month Common Crawl publishes harmonic-centrality and PageRank positions for every
// registered domain it saw across three months of crawling (~118 M rows). It is the only free,
// open, whole-web authority ranking there is — and the graph AI labs are known to sample from.
//
// The ranks file is 2.2 GB gzipped and sorted by rank, not by domain: it cannot be read with a
// range request and is far too large for each self-hosted instance to fetch monthly. So the
// lookup is a tiny HTTP service ("sidecar", see sidecar/ccrank/) that the project owner runs
// once; an instance asks it for one domain. The service holds no user data and needs no key.
//
// Failure is never a verdict: an unreachable directory is "unavailable" and the part is left
// out of the score. Only the directory's own "not in the graph" answer scores zero.

import { safeFetch } from "@/lib/security/safeFetch";
import type { RankPart } from "./types";

/** The public directory. Override with OPENGSC_CCRANK_URL; set it to "off" to disable the part. */
export const CCRANK_DEFAULT_URL = "https://ccrank.opengsc.org";

export function ccRankBaseUrl(env: string | undefined = process.env.OPENGSC_CCRANK_URL): string | null {
  const v = (env ?? "").trim();
  if (/^(off|0|false|none)$/i.test(v)) return null;
  return (v || CCRANK_DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * 0–100 from a rank position. Ranks are heavy-tailed — position 1 000 and position 2 000 are
 * neighbours, position 1 000 and 1 000 000 are not — so the scale is logarithmic:
 * rank 1 → 100, the last rank → 0, the geometric middle of the graph → 50.
 */
export function authorityFromRank(rank: number | null, total: number | null): number | null {
  if (!rank || !total || rank < 1 || total < 2) return null;
  const v = 100 * (1 - Math.log(Math.min(rank, total)) / Math.log(total));
  return Math.round(Math.max(0, Math.min(100, v)));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Map the directory's JSON for one queried domain. Anything malformed is "unavailable". */
export function parseRankResponse(json: unknown, checkedAt: string): RankPart {
  const blank: RankPart = { status: "unavailable", release: null, domain: null, hcRank: null, prRank: null, total: null, hosts: null, authority: null, checkedAt };
  if (!json || typeof json !== "object") return blank;
  const body = json as { release?: unknown; total?: unknown; results?: unknown };
  const release = typeof body.release === "string" ? body.release : null;
  const total = num(body.total);
  const row = Array.isArray(body.results) ? (body.results[0] as Record<string, unknown> | undefined) : undefined;
  if (!release || !total || !row || typeof row !== "object") return blank;
  if (row.found !== true) {
    // A domain absent from a graph of every linked registered domain has no measurable authority.
    return { ...blank, status: "not_found", release, total, authority: 0 };
  }
  const hcRank = num(row.hcRank);
  if (!hcRank) return blank;
  return {
    status: "ok", release, total,
    domain: typeof row.domain === "string" ? row.domain : null,
    hcRank, prRank: num(row.prRank), hosts: num(row.hosts),
    authority: authorityFromRank(hcRank, total),
    checkedAt,
  };
}

export async function fetchRank(domain: string, now: Date = new Date()): Promise<RankPart> {
  const checkedAt = now.toISOString();
  const base = ccRankBaseUrl();
  const blank: RankPart = { status: "unavailable", release: null, domain: null, hcRank: null, prRank: null, total: null, hosts: null, authority: null, checkedAt };
  if (!base) return { ...blank, status: "not_configured" };
  try {
    const res = await safeFetch(`${base}/v1/rank?d=${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/json", "User-Agent": "OpenGSC-AiReady/1.0 (+https://opengsc.org)" },
      timeoutMs: 10_000,
      maxBytes: 65_536,
    });
    if (!res.ok) return blank;
    return parseRankResponse(await res.json(), checkedAt);
  } catch {
    return blank;
  }
}
