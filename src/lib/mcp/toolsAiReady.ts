// MCP tool for AI Readiness: one read-only tool returning the stored report. The checks
// themselves are started from the site's Audit tab — they are free, but the presence part is a
// resumable multi-call job that does not fit a single tool call, so the tool reads, like
// get_site_audit does.

import { type McpTool, resolveSite, siteArg } from "./shared";
import { normAiDomain, readReport } from "@/lib/aiReady/store";
import { rankTier } from "@/lib/aiReady/score";

export const AI_READY_TOOLS: McpTool[] = [
  {
    name: "get_ai_readiness",
    cost: "local",
    description:
      "AI Readiness report for one of the user's sites: a 0–100 score with an A–F grade and the parts it was built from. Access — robots.txt rules for AI crawlers, /llms.txt, and a User-Agent parity probe (the homepage requested as a browser and as GPTBot, ClaudeBot, PerplexityBot and CCBot; a verdict means 'a request announcing that User-Agent got this answer from our address', not proof about the real crawler's IPs). Presence — in which of the last 12 monthly Common Crawl archives the domain appears, with capture counts (absence from a month is a weak signal: Common Crawl samples the web). Rank — the domain's harmonic-centrality and PageRank position in Common Crawl's web graph and a 0–100 log-scaled authority, plus `rankTier` (elite ≤1K, authoritative ≤10K, established ≤100K, strong ≤1M, emerging ≤10M, unranked) — a label, not part of the score. `score.coverage` lists which parts the score includes; parts that could not be read are left out, not counted as zero. Stored data only: if a part is missing, tell the user to run the check in the site's Audit tab (free).",
    inputSchema: { type: "object", properties: { site: siteArg }, required: ["site"] },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const domain = normAiDomain(String(site.url ?? ""));
      const report = await readReport(domain);
      if (!report) return { site: site.url, note: "No AI Readiness report yet — the user can run it in the site's Audit tab (free, no API keys)." };
      // The tier is a label for the rank's order of magnitude (elite ≤1K … emerging ≤10M); it is not part of the score.
      const rankTierName = report.rank && (report.rank.status === "ok" || report.rank.status === "not_found") ? rankTier(report.rank.hcRank) : null;
      return { site: site.url, ...report, rankTier: rankTierName };
    },
  },
];
