// Orchestrator: run one part for one of the caller's own sites and persist it.
//
// The three parts are separate calls on purpose. They have different costs and failure modes
// (six requests to the site; ~15 small range reads per month of Common Crawl; one call to the
// rank directory), and a slow or failing one must not hold back or erase the others.

import { checkAiCrawlability } from "@/lib/audit/aiCrawl";
import { probeParity } from "./parity";
import { fetchCrawlList, httpRangeReader, runPresence } from "./ccPresence";
import { fetchRank } from "./ccRank";
import { readReport, saveParts } from "./store";
import type { AccessPart, AiReadyReport, RankPart } from "./types";

export async function runAccess(rootUrl: string, now: Date = new Date()): Promise<AccessPart> {
  const root = new URL(rootUrl);
  const [crawl, parity] = await Promise.all([checkAiCrawlability(root), probeParity(root.toString())]);
  return { crawl, parity, checkedAt: now.toISOString() };
}

export type PartResult =
  | { ok: true; report: AiReadyReport }
  | { ok: false; error: string };

export async function runPart(domain: string, rootUrl: string, part: "access" | "presence" | "rank"): Promise<PartResult> {
  try {
    if (part === "access") {
      const access = await runAccess(rootUrl);
      return { ok: true, report: await saveParts(domain, { access }) };
    }
    if (part === "presence") {
      const crawls = await fetchCrawlList();
      if (!crawls.length) return { ok: false, error: "cc_list_empty" };
      const prev = (await readReport(domain))?.presence?.months;
      const presence = await runPresence(domain, crawls, prev, httpRangeReader);
      return { ok: true, report: await saveParts(domain, { presence }) };
    }
    const rank: RankPart = await fetchRank(domain);
    return { ok: true, report: await saveParts(domain, { rank }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
}
