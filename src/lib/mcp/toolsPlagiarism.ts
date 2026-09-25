// MCP tools for plagiarism + site: index checks (N6).
//
// Both tools spend the instance owner's SERP credits one query at a time (CONTRACT.md §0.5),
// so both are `paid` and refuse to run without confirm: true — the same gate the web routes
// enforce with the `spend` capability and a price shown above the button.
//
// The refusal is not a dead end: it names the price the run WOULD cost (resolved without a
// single provider call), so the agent puts a concrete number in front of the human instead of
// "may cost money".

import { type McpTool, type Json } from "./shared";
import {
  estimatePlagiarism, runPlagiarismCheck, CACHE_TTL_DAYS,
  type PlagiarismResult,
} from "@/lib/plagiarism";
import { estimateSerpIndexCheck, serpIndexCheckUrls, SERP_INDEX_MAX_URLS } from "@/lib/indexing/serpIndex";

function costSentence(costUsd: number | null, free: boolean, unknown: boolean): string {
  if (free) return "free (self-hosted provider, no per-request cost)";
  if (costUsd == null) return unknown ? "unknown price (provider missing from the price table)" : "no per-request cost";
  return `≈ $${costUsd.toFixed(4)}`;
}

const NO_KEY =
  "No SERP provider is configured. The owner adds a Serper / DataForSEO / ScrapingRobot key or " +
  "connects A-Parser in Settings → SEO Tools.";

export const PLAGIARISM_TOOLS: McpTool[] = [
  {
    name: "check_plagiarism",
    description:
      "PAID · Search the web for exact fragments of a text and report where it was copied from. " +
      "Samples up to 10 rare sentences, runs one quoted SERP query per fragment through the configured " +
      "SERP provider (Serper / DataForSEO / ScrapingRobot / A-Parser), matches results by 4-word shingles " +
      "and repeated URLs, and returns the share of sampled fragments found elsewhere plus the sources. " +
      "An ESTIMATE, not a verdict: quotes, syndication and the site's own pages light up too (own-site " +
      `matches are marked as such and never counted). Results are cached by text hash for ${CACHE_TTL_DAYS} days — ` +
      "re-checking the same text costs nothing. Pass `text`, or `historyId` of a generated article.",
    cost: "paid",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to check (markdown or plain). Required unless historyId is given." },
        historyId: { type: "string", description: "SeoHistory id of a generated article to check instead of pasted text." },
        siteId: { type: "string", description: "Optional site id: pages on this site's domain are marked as own-site matches, not plagiarism." },
        confirm: {
          type: "boolean",
          description: "Must be true. PAID: each sampled fragment is one billed SERP query (≤ 10) on the instance owner's key — get their permission first.",
        },
      },
      required: ["confirm"],
    },
    handler: async (userId: string, args: Json) => {
      const hasInput =
        (typeof args.text === "string" && args.text.trim().length > 0) ||
        (typeof args.historyId === "string" && String(args.historyId).trim() !== "");
      if (!hasInput) throw new Error("Pass either `text` or `historyId`.");

      // Price first, always — including inside the refusal, so the human is asked a concrete question.
      const est = await estimatePlagiarism(userId, { text: args.text, historyId: args.historyId }).catch((e: unknown) => {
        if (e instanceof Error && e.message === "history_not_found") {
          throw new Error("History record not found for this workspace.");
        }
        throw e;
      });
      if (est.error === "no_serp_key") throw new Error(NO_KEY);
      if (args.confirm !== true) {
        throw new Error(
          "check_plagiarism spends the instance owner's own SERP credits, so it will not run unconfirmed. " +
          `This text would run ${est.queries} quoted quer${est.queries === 1 ? "y" : "ies"} via ${est.providerName} — ${costSentence(est.costUsd, est.free, est.unknownPrice)}. ` +
          (est.cached
            ? "The text is already checked and cached, though: calling with confirm: true will serve it for free. "
            : "Ask the user for permission, then call again with confirm: true."),
        );
      }

      // runPlagiarismCheck serves a fresh cache hit without spending; the estimate above already
      // said whether that is the case.
      const out = await runPlagiarismCheck(userId, { text: args.text, historyId: args.historyId, siteId: args.siteId });
      if (!out.ok) {
        if (out.error === "no_text") throw new Error("The text is empty after normalization — nothing to check.");
        if (out.error === "no_fragments") throw new Error("No sentence of 8–25 words without digits survived sampling — paste more prose.");
        if (out.error === "no_serp_key") throw new Error(NO_KEY);
        if (out.error === "cap_exceeded") throw new Error(`Monthly spending cap reached (this check would cost ${out.detail ?? ""}).`);
        throw new Error(`SERP provider failed: ${out.detail ?? out.error}`);
      }
      return shapeResult(out.result!, out.cached === true, out.queries ?? 0, out.costUsd ?? null);
    },
  },
  {
    name: "serp_index_check",
    description:
      "PAID · Estimate whether URLs are in Google's index via a `site:` SERP query — for URLs the URL " +
      "Inspection API cannot reach (drops, other people's sites, domains without a verified Search Console " +
      "property). One query per URL. A captcha or provider failure returns `error`, never `not_indexed`. " +
      "Verdicts are written into the site: index columns (SitemapUrl.serpIndex*) when the URL belongs to a " +
      "site of this workspace; foreign URLs are checked and returned only. This is an estimate read off the " +
      "public SERP, not Google's own verdict.",
    cost: "paid",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: `Absolute URLs to check (homepage or pages), at most ${SERP_INDEX_MAX_URLS}.`,
        },
        confirm: {
          type: "boolean",
          description: "Must be true. PAID: each URL is one billed SERP query on the instance owner's key — get their permission first.",
        },
      },
      required: ["urls", "confirm"],
    },
    handler: async (userId: string, args: Json) => {
      const urls = Array.isArray(args.urls) ? args.urls.map((u) => String(u ?? "").trim()).filter(Boolean) : [];
      if (!urls.length) throw new Error("Pass `urls` (array of absolute URLs).");
      if (urls.length > SERP_INDEX_MAX_URLS) throw new Error(`At most ${SERP_INDEX_MAX_URLS} URLs per call (got ${urls.length}).`);

      const est = await estimateSerpIndexCheck(userId, urls);
      if (est.error === "no_serp_key") throw new Error(NO_KEY);
      if (args.confirm !== true) {
        throw new Error(
          "serp_index_check spends the instance owner's own SERP credits, so it will not run unconfirmed. " +
          `${urls.length} site: quer${urls.length === 1 ? "y" : "ies"} via ${est.provider} — ${costSentence(est.costUsd, est.free, est.unknownPrice)}. ` +
          "Ask the user for permission, then call again with confirm: true.",
        );
      }

      const out = await serpIndexCheckUrls(userId, urls);
      if (!out.ok && out.error === "no_serp_key") throw new Error(NO_KEY);
      if (!out.ok && out.error === "cap_exceeded") throw new Error("Monthly spending cap reached.");
      if (!out.ok && out.error === "provider_failed") {
        throw new Error(`SERP provider failed (${out.detail}). A provider failure is reported as an error — it is never interpreted as "not indexed".`);
      }
      const counts = { indexed: 0, not_indexed: 0, error: 0 };
      for (const r of out.results) counts[r.status]++;
      return {
        ok: true,
        provider: out.provider,
        queries: out.queries,
        ...(out.costUsd != null ? { costUsd: out.costUsd } : {}),
        counts,
        note: "Estimate from search results, not Google's own verdict.",
        results: out.results.map((r) => ({
          url: r.url,
          status: r.status,
          ...(r.matchedUrl ? { matchedUrl: r.matchedUrl } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
          persisted: r.persisted,
        })),
      };
    },
  },
];

function shapeResult(result: PlagiarismResult, cached: boolean, queries: number, costUsd: number | null) {
  return {
    ok: true,
    cached,
    provider: result.provider,
    queries,
    ...(costUsd != null ? { costUsd } : {}),
    matchedPct: result.matchedPct,
    matchedFragments: result.matchedFragments,
    sampledFragments: result.sampledFragments,
    note: "An estimate, not a verdict: quotes, syndication and boilerplate light up too.",
    sources: result.sources.map((s) => ({
      url: s.url, title: s.title, fragments: s.fragments,
      ...(s.ownSite ? { ownSite: true } : {}),
    })),
    fragments: result.fragments.map((f) => ({
      fragment: f.fragment,
      matched: f.matches.some((m) => !m.ownSite),
      matches: f.matches.map((m) => ({
        url: m.url, coverage: Math.round(m.coverage * 100) / 100, reason: m.reason,
        ...(m.ownSite ? { ownSite: true } : {}),
      })),
    })),
    ...(result.providerErrors.length ? { providerErrors: result.providerErrors.slice(0, 5) } : {}),
  };
}
