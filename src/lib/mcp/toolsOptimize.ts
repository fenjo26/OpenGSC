// MCP tools for the page-optimization contour — the "/seo-tools in an agent" surface.
//
// The split here is deliberate and is the answer to an obvious question: why does an MCP
// client, which is itself a language model, need the server to call a second language
// model at all? Usually it does not. The agent can write; what it cannot do is see this
// instance's data or run the app's deterministic checks. So the default path is free:
//
//   get_optimization_brief  → everything known about one page, in one call
//   fetch_page_content      → the page's current body as Markdown
//   analyze_text            → uniqueness, fact drift and structure of a draft, no LLM
//
// An agent that calls those three writes the rewrite itself, and the owner pays for
// exactly one model — the one they are already talking to.
//
// The paid path exists for the cases the agent genuinely cannot reproduce: the outline
// pipeline's MAP/REDUCE fact grounding, Casino RAG, fact-scrub, the user's own editorial
// policy and banned-word list. Those tools are marked PAID, are gated behind
// confirm: true, and run on the key in User.seoSettings.

import { prisma } from "@/lib/prisma";
import {
  McpTool, lim, pct, r1, sinceDate, resolveSite, siteArg,
  resolveAiCreds, assertConfirmed, confirmArg, parseJson,
} from "./shared";
import { scrapePage } from "@/lib/seo/scrape";
import { rewriteContent, maskAIPatterns, headingCounts } from "@/lib/seo/rewrite";
import { factDrift, driftSeverity } from "@/lib/seo/factDrift";
import { uniquenessPct, wordCount } from "@/lib/seo/textMetrics";
import { genByType } from "@/lib/seo/generate";

const jobs = () => (prisma as any).seoJob;

// Match a stored URL against what the agent passed: full URL, path, or a fragment of one.
const pathOf = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
function urlMatches(stored: string, wanted: string): boolean {
  if (!stored) return false;
  const a = stored.toLowerCase().replace(/\/+$/, "");
  const b = wanted.toLowerCase().replace(/\/+$/, "");
  return a === b || pathOf(a) === pathOf(b) || a.includes(b) || b.includes(a);
}

const CTR_BENCHMARKS: Record<number, number> = {
  1: 27.6, 2: 15.8, 3: 11.0, 4: 8.4, 5: 6.3, 6: 4.9, 7: 3.9, 8: 3.3, 9: 2.7, 10: 2.4,
};

export const OPTIMIZE_TOOLS: McpTool[] = [
  {
    name: "get_optimization_brief",
    cost: "net",
    description:
      "FREE, and the entry point for optimizing a page: everything this instance knows about one URL, assembled in a single call — the queries it ranks for, its striking-distance keywords, where its CTR falls short of the benchmark for its position, its traffic trend over recent months, cannibalization conflicts with the site's other pages, its technical audit issues, and (unless disabled) its live title, meta description, headings and body Markdown. Use this to write the rewrite yourself. Only reach for the PAID rewrite_content when the user explicitly wants the app's own pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        url: { type: "string", description: "The page to optimize — full URL or path (e.g. /pricing)" },
        days: { type: "number", description: "Lookback window for the performance data (default 90)" },
        includeContent: { type: "boolean", description: "Fetch the live page for title/meta/headings/body (default true). Set false to stay entirely offline." },
        limit: { type: "number", description: "Max query rows per section (default 30, max 200)" },
      },
      required: ["site", "url"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const wanted = String(args.url ?? "").trim();
      if (!wanted) throw new Error("Missing required argument: url");
      const since = sinceDate(args.days, 90);
      const take = lim(args.limit, 30, 200);

      // One pass over the window; the page's URL form in DailyMetric may be absolute
      // while the agent passed a path, so match rather than filter in SQL.
      const rows = await prisma.dailyMetric.findMany({
        where: { siteId: site.id, date: { gte: since } },
        select: { url: true, query: true, date: true, clicks: true, impressions: true, ctr: true, position: true },
      });
      const mine = rows.filter(r => urlMatches(r.url, wanted));
      if (!mine.length) {
        return {
          site: site.url, url: wanted,
          note: `No metrics found for a page matching "${wanted}" in the last ${Math.round((Date.now() - since.getTime()) / 86_400_000)} days. Check the exact URL with get_search_performance (dimension=page), or widen the days argument.`,
        };
      }
      const fullUrl = mine.find(r => r.url.startsWith("http"))?.url ?? mine[0].url;

      // ── queries this page ranks for ──────────────────────────────────────────
      const byQuery = new Map<string, { clicks: number; impressions: number; ctrSum: number; posSum: number; n: number }>();
      for (const r of mine) {
        if (!r.query) continue;
        const cur = byQuery.get(r.query) ?? { clicks: 0, impressions: 0, ctrSum: 0, posSum: 0, n: 0 };
        cur.clicks += r.clicks; cur.impressions += r.impressions;
        cur.ctrSum += r.ctr; cur.posSum += r.position; cur.n++;
        byQuery.set(r.query, cur);
      }
      const queries = [...byQuery.entries()].map(([query, v]) => {
        const position = r1(v.posSum / v.n);
        const actualCtr = pct(v.ctrSum / v.n);
        const expectedCtr = position <= 10 ? CTR_BENCHMARKS[Math.max(1, Math.round(position))] ?? 0 : 0;
        return {
          query, clicks: v.clicks, impressions: v.impressions, position,
          actualCtrPercent: actualCtr,
          expectedCtrPercent: expectedCtr || null,
          ctrGap: expectedCtr ? r1(actualCtr - expectedCtr) : null,
        };
      }).sort((a, b) => b.impressions - a.impressions);

      // ── traffic trend, last 6 calendar months ────────────────────────────────
      const now = new Date();
      const months = Array.from({ length: 6 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
        return { label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, start: d, end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59), clicks: 0, impressions: 0 };
      });
      for (const r of mine) {
        const t = new Date(r.date).getTime();
        const m = months.find(mo => t >= mo.start.getTime() && t <= mo.end.getTime());
        if (m) { m.clicks += r.clicks; m.impressions += r.impressions; }
      }
      const trend = months.map(m => ({ month: m.label, clicks: m.clicks, impressions: m.impressions }));
      const recent = trend.slice(-2).reduce((s, m) => s + m.clicks, 0);
      const prior = trend.slice(-4, -2).reduce((s, m) => s + m.clicks, 0);

      // ── cannibalization: other pages competing on this page's queries ────────
      const ownQueries = new Set(queries.slice(0, take).map(q => q.query));
      const rivals = new Map<string, { url: string; clicks: number; impressions: number; posSum: number; n: number }>();
      for (const r of rows) {
        if (!r.query || !r.url || !ownQueries.has(r.query) || urlMatches(r.url, wanted)) continue;
        const key = `${r.query}::${r.url}`;
        const cur = rivals.get(key) ?? { url: r.url, clicks: 0, impressions: 0, posSum: 0, n: 0 };
        cur.clicks += r.clicks; cur.impressions += r.impressions; cur.posSum += r.position; cur.n++;
        rivals.set(key, cur);
      }
      const cannibalization = [...rivals.entries()]
        .map(([key, v]) => ({ query: key.split("::")[0], competingPage: v.url, clicks: v.clicks, impressions: v.impressions, position: r1(v.posSum / v.n) }))
        .filter(c => c.impressions > 0)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, take);

      // ── technical audit findings for this page ───────────────────────────────
      let audit: unknown = null;
      const lastAudit = await prisma.siteAudit.findFirst({ where: { siteId: site.id, status: "completed" }, orderBy: { startedAt: "desc" } });
      if (lastAudit) {
        const page = await prisma.siteAuditPage.findFirst({ where: { auditId: lastAudit.id, url: { contains: pathOf(fullUrl) } } });
        if (page) audit = {
          auditedAt: lastAudit.finishedAt, httpStatus: page.httpStatus, title: page.title,
          metaDescription: page.metaDescription, h1Count: page.h1Count, canonical: page.canonical,
          noindex: page.noindex, wordCount: page.wordCount, loadMs: page.loadMs,
          internalLinks: page.internalLinks, imagesNoAlt: page.imagesNoAlt,
          issues: parseJson(page.issues) ?? [], brokenLinks: parseJson(page.brokenLinks) ?? [],
        };
      }

      // ── the page as it stands today ──────────────────────────────────────────
      let content: unknown = null;
      if (args.includeContent !== false && fullUrl.startsWith("http")) {
        try {
          const page = await scrapePage(fullUrl);
          content = page.ok
            ? {
                title: page.title, metaDescription: page.metaDescription, headings: page.headings,
                bodyWords: page.contentWords, linkDensity: page.linkDensity,
                boilerplateOnly: page.boilerplateOnly, markdown: page.contentMarkdown,
              }
            : { error: page.error ?? "fetch failed", note: "The live page could not be fetched — work from the audit fields and query data instead." };
        } catch (e: any) {
          content = { error: String(e?.message ?? e) };
        }
      }

      return {
        site: site.url,
        url: fullUrl,
        windowDays: Math.round((Date.now() - since.getTime()) / 86_400_000),
        totals: {
          clicks: mine.reduce((s, r) => s + r.clicks, 0),
          impressions: mine.reduce((s, r) => s + r.impressions, 0),
          avgPosition: r1(mine.reduce((s, r) => s + r.position, 0) / mine.length),
        },
        trend: { monthly: trend, recent2Months: recent, prior2Months: prior, changePercent: prior > 0 ? Math.round(((recent - prior) / prior) * 100) : null },
        queries: queries.slice(0, take),
        strikingDistance: queries.filter(q => q.position >= 4 && q.position <= 20 && q.impressions >= 10).slice(0, take),
        ctrUnderperforming: queries.filter(q => q.ctrGap != null && q.ctrGap < 0).sort((a, b) => (a.ctrGap ?? 0) - (b.ctrGap ?? 0)).slice(0, take),
        cannibalization,
        audit,
        content,
        howToUse:
          "Write the new version yourself from this brief, then call analyze_text with the original body as `source` to verify uniqueness, that no number or brand was invented, and that the heading structure held. Only use rewrite_content if the user asked for the app's own pipeline.",
      };
    },
  },

  {
    name: "fetch_page_content",
    cost: "net",
    description:
      "FREE: fetch any URL — your own or a competitor's — and return it as clean article Markdown with title, meta description, headings and word count. Boilerplate (menus, footers, sidebars) is stripped by the same readability pass the SEO Tools use, so what comes back is the article rather than the chrome. `boilerplateOnly: true` means no article was found and the result must not be treated as content.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL to fetch" } },
      required: ["url"],
    },
    handler: async (_userId, args) => {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("Pass an absolute http(s) URL.");
      const page = await scrapePage(url);
      if (!page.ok) throw new Error(`Could not fetch ${url}: ${page.error ?? "unknown error"}`);
      return {
        url: page.url, via: page.via, title: page.title, metaDescription: page.metaDescription,
        headings: page.headings, pageWords: page.wordCount, bodyWords: page.contentWords,
        linkDensity: page.linkDensity, boilerplateOnly: page.boilerplateOnly,
        hasFaq: page.hasFaq, hasPriceTable: page.hasPriceTable,
        markdown: page.contentMarkdown,
      };
    },
  },

  {
    name: "analyze_text",
    cost: "local",
    description:
      "FREE and deterministic — no model is called, so this costs nothing and returns the same answer every time. Given a draft and the source it replaces, reports: uniqueness (1 − word-trigram overlap), fact drift (numbers and identifiers that were INVENTED or dropped — invented is the dangerous direction, since a wrong price ships), heading-structure match, word count, and a count of common machine tells (em dashes, \"furthermore\", \"it is important to note\"). Run it on every rewrite you produce before handing it to the user.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The draft to analyze" },
        source: { type: "string", description: "The original text it is meant to replace. Omit to get word count and machine tells only — drift and uniqueness need something to compare against." },
      },
      required: ["text"],
    },
    handler: async (_userId, args) => {
      const text = String(args.text ?? "");
      if (!text.trim()) throw new Error("Missing required argument: text");
      const source = String(args.source ?? "");

      // maskAIPatterns rewrites the tells away; the size of the edit is a usable proxy
      // for how many there were, without duplicating its regex table here.
      const masked = maskAIPatterns(text);
      const tells = masked === text ? 0 : Math.abs(masked.length - text.length) + (masked.split(/\s+/).length !== text.split(/\s+/).length ? 1 : 0);

      const base = {
        words: wordCount(text),
        chars: text.length,
        headings: { h1: headingCounts(text)[0], h2: headingCounts(text)[1], h3: headingCounts(text)[2], all: headingCounts(text) },
        machineTells: { detected: masked !== text, editDistanceChars: tells, cleaned: masked !== text ? masked.slice(0, 400) : null },
      };
      if (!source.trim()) {
        return { ...base, note: "No `source` given — uniqueness and fact drift were skipped. Pass the original text to check what changed." };
      }

      const drift = factDrift(source, text);
      const expected = headingCounts(source);
      const got = headingCounts(text);
      return {
        ...base,
        uniquenessPercent: uniquenessPct(source, text),
        sourceWords: wordCount(source),
        wordDeltaPercent: wordCount(source) ? Math.round(((base.words - wordCount(source)) / wordCount(source)) * 100) : null,
        factDrift: {
          severity: driftSeverity(drift),
          clean: drift.clean,
          numbers: drift.numbers,
          identifiers: drift.identifiers,
        },
        structure: { expected, got, ok: expected.every((n, i) => n === got[i]) },
        verdict:
          driftSeverity(drift) === "danger"
            ? "Values appear in the draft that are not in the source — these are invented and must be corrected or removed before publishing."
            : driftSeverity(drift) === "warn"
              ? "Some source values were dropped. Check whether they mattered."
              : "No numeric or identifier drift detected.",
      };
    },
  },

  {
    name: "rewrite_content",
    cost: "paid",
    description:
      "PAID — spends the instance owner's own AI credits and needs confirm: true. Runs OpenGSC's Content Rewriter server-side: N unique variants of a text or URL, each scored for uniqueness, fact drift and heading structure, with optional refreshed title/meta. Prefer get_optimization_brief + your own writing + analyze_text, which costs the owner nothing and gives you the same checks. Use this when the user explicitly wants the app's pipeline, its editorial policy, or its banned-word list applied.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: confirmArg,
        text: { type: "string", description: "Source text to rewrite (or pass `url` instead)" },
        url: { type: "string", description: "URL to fetch and rewrite (alternative to `text`)" },
        variants: { type: "number", description: "How many variants, 1–5 (default 1)" },
        language: { type: "string", description: "Target language NAME, e.g. \"Greek\". Omit to keep the source language." },
        tone: { type: "string", description: "Optional tone hint" },
        maskAI: { type: "boolean", description: "Strip common machine tells from the output (default true)" },
        bannedWords: { type: "array", items: { type: "string" }, description: "Words the model must not use — the AI-Fingerprint Lab's marker export goes here" },
        temperature: { type: "number", description: "Sampling temperature; omit for the provider default" },
        snippet: { type: "boolean", description: "Also propose a refreshed title + meta description" },
      },
      required: ["confirm"],
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "rewrite_content");
      if (!String(args.text ?? "").trim() && !String(args.url ?? "").trim()) {
        throw new Error("Pass either `text` or `url`.");
      }
      const creds = await resolveAiCreds(userId, args);
      if (!creds.aiApiKey) {
        throw new Error("No AI key is configured on this instance. The owner adds one in SEO Tools → Settings (it is mirrored server-side for background jobs). Meanwhile, get_optimization_brief gives you the material to write from yourself.");
      }
      const result = await rewriteContent({
        text: args.text ? String(args.text) : undefined,
        url: args.url ? String(args.url) : undefined,
        variants: Math.min(5, Math.max(1, Number(args.variants ?? 1))),
        language: args.language ? String(args.language) : undefined,
        tone: args.tone ? String(args.tone) : undefined,
        maskAI: args.maskAI !== false,
        bannedWords: Array.isArray(args.bannedWords) ? args.bannedWords.map(String) : undefined,
        temperature: args.temperature != null ? Number(args.temperature) : undefined,
        snippet: args.snippet === true,
        ...creds,
      });
      if (!result.ok) {
        throw new Error(
          result.error === "no_ai_key" ? "No AI key configured for the selected provider."
            : result.error === "no_content" ? "Nothing to rewrite — the URL yielded no article body (navigation only), or the text was empty."
            : `Rewrite failed: ${result.error}`);
      }
      const d = result.data!;
      return {
        sourceWords: d.sourceWords,
        sourceTitle: d.title ?? null,
        snippet: d.snippet ?? null,
        variants: d.variants.map(v => ({
          uniquenessPercent: v.uniqueness,
          words: v.words,
          factDrift: { severity: driftSeverity(v.drift), clean: v.drift.clean, numbersAdded: v.drift.numbers.added, numbersLost: v.drift.numbers.lost, identifiersAdded: v.drift.identifiers.added, identifiersLost: v.drift.identifiers.lost },
          structureOk: v.structure?.ok ?? null,
          repaired: v.repaired ?? false,
          content: v.content,
        })),
        warning: "Values listed under numbersAdded/identifiersAdded do not exist in the source — verify them before publishing.",
      };
    },
  },

  {
    name: "start_generation_job",
    cost: "paid",
    description:
      "PAID — spends the instance owner's own AI credits and needs confirm: true. Starts a background SEO Tools generation job and returns its id immediately; the pipeline runs for minutes (competitor scrape, MAP/REDUCE fact grounding, fact-scrub, chunked writing, volume guard), far longer than a tool call can wait. Poll get_generation_job for the result. Types: outline, outline_auto, text (needs the outline from a finished outline job), analysis, landing, cluster. Use this only when the user wants the app's full pipeline — for a straightforward rewrite, get_optimization_brief and your own writing is free.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: confirmArg,
        type: { type: "string", enum: ["outline", "outline_auto", "text", "analysis", "landing", "cluster"], description: "Which pipeline to run" },
        keyword: { type: "string", description: "The target keyword (required for outline/analysis/cluster)" },
        payload: { type: "object", description: "Pipeline payload, the same shape the /seo-tools UI posts — e.g. { keyword, language, wordCount, country } for outline, or { outline } for text" },
      },
      required: ["confirm", "type"],
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "start_generation_job");
      const type = String(args.type ?? "");
      if (!["outline", "outline_auto", "text", "analysis", "landing", "cluster"].includes(type)) {
        throw new Error(`Unknown job type: ${type}`);
      }
      const creds = await resolveAiCreds(userId, args);
      if (!creds.aiApiKey) throw new Error("No AI key is configured on this instance (SEO Tools → Settings).");

      const payload = { ...(args.payload as object ?? {}), ...creds };
      const keyword = String(args.keyword ?? (payload as any).keyword ?? "").slice(0, 300);
      let job: any;
      try {
        job = await jobs().create({ data: { userId, type, keyword, status: "processing" } });
      } catch (e: any) {
        throw new Error(`Could not create the job row: ${String(e?.message ?? e)} (run: npx prisma db push)`);
      }

      // Fire-and-forget, matching /api/seo/jobs — the promise outlives the response and
      // writes its own terminal state. Jobs stuck past 20 minutes are auto-failed on read.
      genByType(type, payload)
        .then(async r => {
          await jobs().update({
            where: { id: job.id },
            data: r.ok ? { status: "completed", result: JSON.stringify(r.data) } : { status: "error", error: r.error },
          });
        })
        .catch(async (e: any) => {
          try { await jobs().update({ where: { id: job.id }, data: { status: "error", error: String(e?.message ?? e) } }); } catch { /* row gone */ }
        });

      return {
        jobId: job.id,
        type,
        keyword,
        status: "processing",
        next: "Poll get_generation_job with this jobId. Outlines usually take 1–3 minutes, full articles 3–10. Do not start another job for the same keyword while this one runs.",
      };
    },
  },

  {
    name: "get_generation_job",
    cost: "local",
    description:
      "FREE: check a background generation job started by start_generation_job — status, and the full result once it completes. Jobs left processing for over 20 minutes are reported as timed out (the process restarted mid-run). On error, the message carries the provider's own reason, including content-policy rejections.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The id returned by start_generation_job. Omit to list recent jobs." },
      },
    },
    handler: async (userId, args) => {
      const jobId = String(args.jobId ?? "").trim();
      try {
        // Same staleness sweep the UI does on list — a job whose process died must not
        // sit at "processing" forever and have an agent poll it in a loop.
        const cutoff = new Date(Date.now() - 20 * 60 * 1000);
        try { await jobs().updateMany({ where: { userId, status: "processing", updatedAt: { lt: cutoff } }, data: { status: "error", error: "stale_timeout" } }); } catch { /* not migrated */ }

        if (!jobId) {
          const list = await jobs().findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, type: true, keyword: true, status: true, error: true, createdAt: true } });
          return { count: list.length, jobs: list };
        }
        const job = await jobs().findFirst({ where: { id: jobId, userId } });
        if (!job) throw new Error(`Job not found: ${jobId}`);
        return {
          jobId: job.id, type: job.type, keyword: job.keyword, status: job.status,
          createdAt: job.createdAt, updatedAt: job.updatedAt,
          error: job.error === "stale_timeout" ? "The job did not finish within 20 minutes — the server most likely restarted mid-run. Start it again." : job.error,
          result: job.status === "completed" ? parseJson(job.result) : null,
        };
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("Job not found")) throw e;
        return { count: 0, jobs: [], note: "SeoJob table not available on this instance (run: npx prisma db push)." };
      }
    },
  },
];
