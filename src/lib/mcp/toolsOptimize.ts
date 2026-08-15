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
import { rawQuery } from "@/lib/db/raw";
import { runUpsert } from "@/lib/db/upsert";
import {
  McpTool, lim, pct, r1, sinceDate, resolveSite, siteArg,
  resolveAiCreds, resolveAiFallbacks, resolveSerpCreds, resolveKeywordSource, resolveActivePolicy, taskForJobType, assertConfirmed, confirmArg, parseJson,
} from "./shared";
import { expandKeywords } from "@/lib/seo/keywordSource";
import { priceExpand } from "@/lib/seo/metrics";
import { readUsage, recordUsage, withinCap, releaseUnusedUnits } from "@/lib/seo/metricsStore";
import { scrapePage } from "@/lib/seo/scrape";
import { maskAIPatterns, headingCounts } from "@/lib/seo/rewrite";
import { runRewriteBatch } from "@/lib/seo/rewriteBatch";
import { factDrift, driftSeverity } from "@/lib/seo/factDrift";
import { uniquenessPct, wordCount } from "@/lib/seo/textMetrics";
import { genByType } from "@/lib/seo/generate";
import { failStaleSeoJobs, withSeoJobHeartbeat } from "@/lib/jobs/lifecycle";
import { coerceOutline } from "./outlineShape";

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

// ─── outline resolution for text jobs ────────────────────────────────────────────
// Everything below makes the wrong outline shape impossible to hand over silently; the shape
// logic itself (what counts as an outline) lives in outlineShape.ts, pure and unit-tested.

// outlineId → outline. Two stores, in the order an agent will reach for them: SeoHistory
// (what get_generations lists — the same records the browser's structure picker syncs from),
// then a completed outline/outline_auto SeoJob — so the jobId the agent just polled works as
// the outlineId of the follow-up text job with zero extra calls.
async function fetchSavedOutline(userId: string, outlineId: string): Promise<{ outline: any; keyword: string } | null> {
  const id = outlineId.trim();
  if (!id) return null;
  try {
    const rows: any[] = await rawQuery(
      `SELECT keyword, data FROM "SeoHistory" WHERE id = ? AND userId = ?`, id, userId);
    if (rows.length) {
      const outline = coerceOutline(parseJson(rows[0].data));
      if (outline) return { outline, keyword: String(rows[0].keyword ?? "") };
    }
  } catch { /* table not migrated → try the job row */ }
  try {
    const job = await jobs().findFirst({
      where: { id, userId, status: "completed", type: { in: ["outline", "outline_auto"] } },
    });
    if (job) {
      const outline = coerceOutline(parseJson(job.result));
      if (outline) return { outline, keyword: String(job.keyword ?? "") };
    }
  } catch { /* not migrated either → caller reports the miss */ }
  return null;
}

// ─── completed jobs → the shared History store ───────────────────────────────────
// The browser imports finished jobs into localStorage History (and backs it up to SeoHistory,
// which get_generations reads and the structure picker syncs from). MCP-started jobs used to
// stop at the SeoJob row, so an outline an agent generated was invisible to the UI and to
// get_generations — two stores, no bridge. This is the bridge, with importJob's exact
// type/data mapping so both sides file the job identically.
const HISTORY_TYPE: Record<string, string> = {
  outline: "outline", outline_auto: "outline", text: "text",
  analysis: "analysis", landing: "landing", cluster: "cluster",
};
async function saveJobToHistory(userId: string, job: any, result: unknown): Promise<void> {
  const htype = HISTORY_TYPE[String(job.type)];
  if (!htype || result == null) return;
  const data = job.type === "text" ? ((result as any)?.text ?? result) : result;
  try {
    await runUpsert({
      table: "SeoHistory",
      conflict: ["id"],
      values: {
        id: job.id, userId, type: htype, keyword: job.keyword || "—",
        status: "completed", data: JSON.stringify(data),
        meta: JSON.stringify({ jobId: job.id }),
        createdAt: new Date(job.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      // id never drifts, and createdAt keeps the original moment. The browser adopts this row
      // through its history sync (missing ids merge in), so its later pushes refresh the copy.
      update: { data: "set", meta: "set", status: "set", keyword: "set", updatedAt: "set" },
    });
  } catch { /* SeoHistory not migrated — the SeoJob row still carries the result */ }
}

export const OPTIMIZE_TOOLS: McpTool[] = [
  {
    name: "get_optimization_brief",
    cost: "net",
    description:
      "FREE, and the entry point for optimizing a page: everything this instance knows about one URL, assembled in a single call — the queries it ranks for, its striking-distance keywords, where its CTR falls short of the benchmark for its position, its traffic trend over recent months, cannibalization conflicts with the site's other pages, its technical audit issues, and (unless disabled) its live title, meta description, headings and body Markdown. Use this to write the rewrite yourself. Only reach for the PAID start_rewrite_job when the user explicitly wants the app's own pipeline.",
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
          "Write the new version yourself from this brief, then call analyze_text with the original body as `source` to verify uniqueness, that no number or brand was invented, and that the heading structure held. Only use start_rewrite_job if the user asked for the app's own pipeline.",
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
    name: "start_rewrite_job",
    cost: "paid",
    description:
      "PAID — spends the instance owner's own AI credits and needs confirm: true. Rewrites up to 20 pages with OpenGSC's Content Rewriter, in the BACKGROUND: returns a jobId immediately, then poll get_generation_job. One page takes minutes (fetch, then a long model call, then a repair pass when the value audit fails), which is far longer than any MCP client will hold a tool call open — so this never returns the text directly. Each page is saved the moment it finishes, so a timeout, a closed client or a server restart costs at most the page in flight and never the ones already paid for. Prefer get_optimization_brief + your own writing + analyze_text, which costs the owner nothing; use this when they want the app's own pipeline, editorial policy or banned-word list applied.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: confirmArg,
        urls: { type: "array", items: { type: "string" }, description: "1–20 page URLs to rewrite, processed one after another" },
        text: { type: "string", description: "Literal text to rewrite instead of URLs (single item)" },
        language: { type: "string", description: "Target language NAME, e.g. \"Greek\". Omit to keep each page's own language." },
        tone: { type: "string", description: "Optional tone hint" },
        maskAI: { type: "boolean", description: "Strip common machine tells from the output (default true)" },
        bannedWords: { type: "array", items: { type: "string" }, description: "Words the model must not use — the AI-Fingerprint Lab's marker export goes here" },
        temperature: { type: "number", description: "Sampling temperature; omit for the provider default" },
        snippet: { type: "boolean", description: "Also propose a refreshed title + meta description per page" },
        policyName: { type: "string", description: "Editorial policy to write under, by name. Omit to use the instance's active policy." },
      },
      required: ["confirm"],
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "start_rewrite_job");

      const urls = (Array.isArray(args.urls) ? args.urls : []).map(String).map(s => s.trim()).filter(Boolean);
      const text = String(args.text ?? "").trim();
      if (!urls.length && !text) throw new Error("Pass `urls` (1–20 page URLs) or `text`.");
      if (urls.length > 20) throw new Error(`Too many URLs (${urls.length}). Send at most 20 per job — a long batch is fine, but one that runs for hours is hard to supervise and hard to stop.`);
      const bad = urls.filter(u => !/^https?:\/\//i.test(u));
      if (bad.length) throw new Error(`These are not absolute URLs: ${bad.slice(0, 5).join(", ")}`);

      const creds = await resolveAiCreds(userId, args, "text");
      if (!creds.aiApiKey) {
        throw new Error("No AI key is configured on this instance. The owner adds one in SEO Tools → Settings (it is mirrored server-side for background jobs). Meanwhile, get_optimization_brief gives you the material to write from yourself, for free.");
      }

      // One rewrite batch at a time per user. Two batches would race for the same provider
      // rate limit and make each other look like failures, and an agent that polls, sees
      // nothing yet and starts a second job is a very easy way to pay twice for one page.
      try {
        const running = await jobs().findFirst({ where: { userId, type: "rewrite", status: "processing" } });
        if (running) {
          throw new Error(`A rewrite job is already running (jobId ${running.id}). Poll it with get_generation_job; start another only once it is finished.`);
        }
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("A rewrite job is already running")) throw e;
        // Table not migrated — fall through and let the create below report it properly.
      }

      const items = urls.length ? urls.map(u => ({ url: u })) : [{ text, label: "(pasted text)" }];
      let job: any;
      try {
        job = await jobs().create({
          data: {
            userId,
            type: "rewrite",
            keyword: urls.length ? `${urls.length} page${urls.length > 1 ? "s" : ""}` : "pasted text",
            status: "processing",
            stage: "rewrite",
            progress: 0,
            heartbeatAt: new Date(),
            resumable: false,
            meta: JSON.stringify({ urls, snippet: args.snippet === true, language: args.language ?? null }),
          },
        });
      } catch (e: any) {
        throw new Error(`Could not create the job row: ${String(e?.message ?? e)} (run: npx prisma db push)`);
      }

      // Fire-and-forget. The promise outlives this response and writes its own progress;
      // see runRewriteBatch for why the result is persisted per page rather than at the end.
      runRewriteBatch(job.id, items, {
        variants: 1,
        language: args.language ? String(args.language) : undefined,
        tone: args.tone ? String(args.tone) : undefined,
        maskAI: args.maskAI !== false,
        bannedWords: Array.isArray(args.bannedWords) ? args.bannedWords.map(String) : undefined,
        temperature: args.temperature != null ? Number(args.temperature) : undefined,
        snippet: args.snippet === true,
        policy: await resolveActivePolicy(userId, args),
        ...creds,
      }).catch(() => { /* runRewriteBatch records its own failures */ });

      return {
        jobId: job.id,
        pages: items.length,
        status: "processing",
        next: `Poll get_generation_job with jobId "${job.id}". Expect roughly 1–4 minutes per page. Finished pages appear in the result as they complete, so an early poll returns partial work rather than nothing — do NOT start a second job while this one runs.`,
      };
    },
  },

  {
    name: "start_generation_job",
    cost: "paid",
    description:
      "PAID — spends the instance owner's own AI credits and needs confirm: true. Starts a background SEO Tools generation job and returns its id immediately; the pipeline runs for minutes (competitor scrape, MAP/REDUCE fact grounding, fact-scrub, chunked writing, volume guard), far longer than a tool call can wait. Poll get_generation_job for the result. Types: outline, outline_auto (SERP→scrape→outline in one unattended step), text (writes the article FROM an outline), analysis, landing, cluster. Completed results are saved to SEO Tools → History, so finished outlines appear in the UI Text generator's structure picker and in get_generations. HOW TO WRITE AN ARTICLE (same clicks as the UI): 1) start_generation_job type=outline with the keyword, country, language and keywordIdeas:{} — that last one is the UI's 'load keywords' button: real ideas with volumes from the user's Ahrefs/Semrush/DataForSEO key, billed against the same monthly cap; 2) poll get_generation_job until completed; 3) start_generation_job type=text with outlineId set to that jobId — the server loads the outline itself, with its facts bank, keyword and language. The text step's form fields (language, tone, sourceMode, promptType+custom, includeToc, targetWordCount, temperature, bannedWords) are top-level arguments with the UI's defaults; anything else the /seo-tools pages post (competitors, gl/hl, generate) goes in payload. For a straightforward rewrite, get_optimization_brief and your own writing is free.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: confirmArg,
        type: { type: "string", enum: ["outline", "outline_auto", "text", "analysis", "landing", "cluster"], description: "Which pipeline to run" },
        keyword: { type: "string", description: "The target keyword — top-level, exactly like the UI's keyword field (required for outline/outline_auto/analysis/cluster; for text it defaults to the outline's own keyword)" },
        outlineId: { type: "string", description: "type=text: the structure to write from — the jobId of a finished outline/outline_auto job, or an id from get_generations. This is the server-side equivalent of the UI's structure picker; use it instead of passing the outline object around." },
        keywordIdeas: {
          type: "object",
          description: "outline/outline_auto/landing only — the UI's 'load keywords' step: fetch real keyword ideas with volumes from the instance's configured provider (Ahrefs/Semrush/DataForSEO, official or reseller) and ground the outline on them. Spends provider units against the same monthly cap as the UI button. Pass {} for the Settings defaults, or { limit: 50-200, withDifficulty: boolean, mode: 'matching'|'related' }. Requires country — the market is never guessed.",
          properties: {
            limit: { type: "number", description: "Max ideas to request — the ceiling on what this can cost (50–200, default from Settings)" },
            withDifficulty: { type: "boolean", description: "Also fetch keyword difficulty (costs more units on Ahrefs)" },
            mode: { type: "string", enum: ["matching", "related"], description: "matching = keywords containing the seed; related = semantic neighbours (default matching)" },
          },
        },
        language: { type: "string", description: "Language code, e.g. en, ru, el, fr. Outline jobs default to en; text jobs inherit the outline's own language when omitted." },
        country: { type: "string", description: "Two-letter market code for outline/landing/cluster (default us) — drives SERP geo and the outline's country meta." },
        tone: { type: "string", description: "Free-text tone hint, e.g. 'expert, friendly, no hype' (the UI maps its tone dropdown to the same kind of string)." },
        promptType: { type: "string", enum: ["service", "custom"], description: "Service prompt (default) or a fully custom writing prompt — same radio as the UI Text generator." },
        custom: { type: "string", description: "With promptType=custom: the whole writing prompt. With service: a short additional instruction appended to it (the UI's 'custom instruction' box)." },
        sourceMode: { type: "string", enum: ["off", "facts", "cited"], description: "Competitor sourcing for the article (UI default off). off still grounds the text on the facts bank the outline was built on; facts/cited additionally scrape live SERP competitors — slower." },
        includeToc: { type: "boolean", description: "Insert a table-of-contents block after H1 (default false)." },
        targetWordCount: { type: "number", description: "Target article length in words — sets outline section budgets and drives the volume guard." },
        temperature: { type: "number", description: "Sampling temperature; omit for the provider default. The outline phase caps it at 0.8 (JSON reliability)." },
        bannedWords: { type: "array", items: { type: "string" }, description: "Words the model must not use — the AI-Fingerprint Lab's marker export goes here." },
        payload: { type: "object", description: "Pipeline payload, the same shape the /seo-tools UI posts — e.g. { competitors, paa, related } for outline, { gl, hl, keywords } for cluster, { generate } for landing. The common knobs above are top-level arguments; payload wins when both are given." },
        policyName: { type: "string", description: "Editorial policy to write under, by name. Omit to use the instance's active policy — it is applied either way." },
      },
      required: ["confirm", "type"],
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "start_generation_job");
      const type = String(args.type ?? "");
      if (!["outline", "outline_auto", "text", "analysis", "landing", "cluster"].includes(type)) {
        throw new Error(`Unknown job type: ${type}`);
      }
      // Resolve against the SAME per-task override the equivalent SEO Tools page would use, so a
      // job started by an agent runs on the model the user configured for that step rather than
      // silently falling back to the SEO-wide one.
      const creds = await resolveAiCreds(userId, args, taskForJobType(type));
      if (!creds.aiApiKey) throw new Error("No AI key is configured on this instance (SEO Tools → Settings).");

      // outline, outline_auto, landing and cluster run SERP calls to scrape competitor context
      // before touching the AI provider — resolve serpCreds so `payload.serpKey` and `payload.serpProvider`
      // are passed through for all generation jobs over MCP.
      const serpCreds = (type === "outline" || type === "outline_auto" || type === "landing" || type === "cluster")
        ? await resolveSerpCreds(userId, args)
        : null;

      // The tool pages send the active policy in the request body; nothing here did, so every
      // agent-started job generated with no editorial policy whatsoever. An explicit `policy` in
      // args still wins, and an instance with no policies stored resolves to undefined — same
      // payload as before.
      const policy = (args.payload as any)?.policy ?? (await resolveActivePolicy(userId, args));

      // The Text page's form fields, hoisted to top-level args so an agent drives the same knobs
      // the UI exposes. They land in the payload exactly as the browser posts them, and an
      // explicit payload field still wins. `keyword` belongs here too: the schema always
      // documented it as a top-level argument, but it was only ever written to the job ROW —
      // the pipeline read payload.keyword, so an agent following the docs got `no_keyword`
      // unless it ALSO nested the keyword inside payload.
      const knobs: Record<string, unknown> = {};
      for (const k of ["keyword", "language", "country", "tone", "promptType", "custom", "sourceMode", "includeToc", "targetWordCount", "temperature", "bannedWords"]) {
        if (args[k] !== undefined && args[k] !== null) knobs[k] = args[k];
      }
      const payload: any = { ...knobs, ...((args.payload as object) ?? {}), ...creds, ...(serpCreds ?? {}), ...(policy ? { policy } : {}) };

      // Standby providers for the outline step. An agent-started job is the LEAST supervised
      // path in the product — nobody is watching a progress bar to notice the configured
      // provider has started discarding finished generations — so it is the path that most
      // needs to be able to finish on a different one.
      if (!payload.aiFallbacks) {
        try {
          const alts = await resolveAiFallbacks(userId, creds.aiProvider);
          if (alts.length) payload.aiFallbacks = alts;
        } catch { /* a missing safety net must not block the job */ }
      }

      // The Outline page's "load keywords" step, server-side: pull real ideas with volumes
      // from the provider the user configured (Ahrefs/Semrush/DataForSEO, resolved the same
      // way getKeywordSource() resolves it in the browser) and ground the outline on them —
      // the exact fields the form posts (keywordsData + keywordsSource). Opt-in, and billed
      // against the same monthly cap through the same metricsStore the UI button uses, so the
      // agent path is not a second, unaccounted billing path.
      if ((type === "outline" || type === "outline_auto" || type === "landing") && args.keywordIdeas) {
        const opts: any = args.keywordIdeas === true ? {} : (args.keywordIdeas as object ?? {});
        const seed = String(args.keyword ?? payload.keyword ?? "").trim();
        const country = String(payload.country ?? "").trim().toLowerCase();
        if (!seed) throw new Error("keywordIdeas needs the keyword — pass it as the top-level keyword argument.");
        // The market is never defaulted (same rule as keywordSource.ts): ideas filed under the
        // wrong country are cache rows nobody will ever read again.
        if (!country) throw new Error("keywordIdeas needs a country — pass the top-level country argument (e.g. \"gr\", \"us\").");
        const kw = await resolveKeywordSource(userId);
        if (!kw) throw new Error("No keyword provider configured. The user sets one in Settings → SEO Metrics (Ahrefs/Semrush, official or reseller) or a DataForSEO key in SEO Tools settings.");
        const limit = Math.max(50, Math.min(200, Number(opts.limit ?? kw.limit) || kw.limit));
        const withDifficulty = opts.withDifficulty === true;
        const mode = opts.mode === "related" ? "related" as const : "matching" as const;
        const price = priceExpand(kw.source, limit, withDifficulty, mode);
        if (price.units && !(await withinCap(userId, kw.source, price.units, kw.cap))) {
          throw new Error(`Monthly ${kw.source} cap would be exceeded (this call: ${price.units} units). Raise the cap in Settings → SEO Metrics or retry next month.`);
        }
        if (price.units) await recordUsage(userId, kw.source, price.units);
        let res;
        try {
          res = await expandKeywords({ source: kw.source, apiKey: kw.apiKey, baseUrl: kw.baseUrl }, seed, {
            country, language: String(payload.language ?? "en"), limit, withDifficulty, mode, fetch: true,
          });
        } catch (e: any) {
          if (price.units) await releaseUnusedUnits(userId, kw.source, price.units, 0);
          throw new Error(`Keyword ideas fetch failed: ${String(e?.message ?? e).slice(0, 300)}`);
        }
        // Ahrefs bills the rows returned, not the limit asked for — give the difference back,
        // exactly as /api/seo/keyword-ideas does.
        if (price.units) await releaseUnusedUnits(userId, kw.source, price.units, res.units || 0);
        if (!res.rows.length) throw new Error(`Keyword ideas returned nothing${res.error ? `: ${res.error}` : ""}.`);
        payload.keywordsData = res.rows;
        payload.keywordsSource = res.source;
      }

      // type=text: resolve the outline exactly as the UI's structure picker does — by id, from
      // the saved structures. Whatever outline the agent passed directly is unwrapped to the
      // outline object; if nothing outline-shaped remains, refuse rather than let genText write
      // a fluent article about nothing (that failure mode is invisible AND paid).
      if (type === "text") {
        const saved = args.outlineId ? await fetchSavedOutline(userId, String(args.outlineId)) : null;
        if (args.outlineId && !saved) {
          throw new Error(
            `outlineId "${args.outlineId}" matched no saved structure and no completed outline job. ` +
            `Call get_generations with type=outline to list what exists, or run an outline job first.`,
          );
        }
        const outline = saved ? saved.outline : coerceOutline(payload.outline);
        if (!outline) {
          throw new Error(
            "A text job needs the outline itself, and nothing outline-shaped (an object with .sections) was found in outlineId or payload.outline. " +
            "Pass outlineId — the jobId of the finished outline job, or an id from get_generations — and the server loads it with its facts bank, keyword and language.",
          );
        }
        payload.outline = outline;
        payload.keyword = String(payload.keyword ?? saved?.keyword ?? outline?.meta?.keyword ?? "");
        payload.language = String(payload.language ?? outline?.meta?.language ?? "en");
      }

      const keyword = String(args.keyword ?? payload.keyword ?? "").slice(0, 300);
      let job: any;
      try {
        job = await jobs().create({
          data: {
            userId, type, keyword, status: "processing", stage: "generating", progress: 5,
            heartbeatAt: new Date(), resumable: false,
          },
        });
      } catch (e: any) {
        throw new Error(`Could not create the job row: ${String(e?.message ?? e)} (run: npx prisma db push)`);
      }

      // Fire-and-forget, matching /api/seo/jobs — the promise outlives the response and
      // writes its own terminal state. The heartbeat is what keeps a genuinely long run
      // from tripping the 20-minute staleness sweep while it is still working.
      withSeoJobHeartbeat(job.id, genByType(type, payload))
        .then(async r => {
          await jobs().update({
            where: { id: job.id },
            data: r.ok
              ? { status: "completed", stage: "completed", progress: 100, heartbeatAt: new Date(), result: JSON.stringify(r.data) }
              : { status: "error", stage: "error", heartbeatAt: new Date(), error: r.error },
          });
          // The UI's History imports finished jobs and backs them up to SeoHistory; an
          // agent-started job has no browser to do that, so the server files it itself.
          // This is what makes a finished outline selectable in the Text generator's
          // structure picker and listed by get_generations.
          if (r.ok) await saveJobToHistory(userId, job, r.data);
        })
        .catch(async (e: any) => {
          try {
            await jobs().update({
              where: { id: job.id },
              data: { status: "error", stage: "error", heartbeatAt: new Date(), error: String(e?.message ?? e) },
            });
          } catch { /* row gone */ }
        });

      return {
        jobId: job.id,
        type,
        keyword,
        status: "processing",
        next: type === "outline" || type === "outline_auto"
          ? `Poll get_generation_job with this jobId. Outlines take 2–8 minutes (SERP scrape + fact grounding). When it completes the outline is saved as a structure — pass this same jobId as outlineId to the text job, no need to copy the outline around.`
          : type === "text"
            ? "Poll get_generation_job with this jobId. Full articles take 3–10 minutes; the result carries usedSources — 0 there means the article was NOT grounded on the outline's facts bank, re-check the outline. Do not start another job for the same keyword while this one runs."
            : "Poll get_generation_job with this jobId. Do not start another job for the same keyword while this one runs.",
      };
    },
  },

  {
    name: "get_generation_job",
    cost: "local",
    description:
      "FREE: check a background job started by start_generation_job or start_rewrite_job — status, progress, and the result. Rewrite batches report per-page progress and return finished pages as they complete, so polling early gives partial work rather than nothing; pass includeContent to get the rewritten text itself. Jobs silent for over 20 minutes are reported as timed out (the process restarted mid-run). On error, the message carries the provider's own reason, including content-policy rejections.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The id returned by start_generation_job / start_rewrite_job. Omit to list recent jobs." },
        includeContent: { type: "boolean", description: "For rewrite batches: include each page's full rewritten text (default false — the summary alone is usually what you want, and 20 articles is a lot to read at once)" },
        page: { type: "string", description: "For rewrite batches: return just this one page's full result (URL or substring)" },
      },
    },
    handler: async (userId, args) => {
      const jobId = String(args.jobId ?? "").trim();
      try {
        // Same staleness sweep the UI does on list. A dedicated heartbeat avoids marking a
        // healthy but slow provider call as dead just because its result is not ready yet.
        await failStaleSeoJobs(userId);

        if (!jobId) {
          const list = await jobs().findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, type: true, keyword: true, status: true, error: true, createdAt: true } });
          return { count: list.length, jobs: list };
        }
        const job = await jobs().findFirst({ where: { id: jobId, userId } });
        if (!job) throw new Error(`Job not found: ${jobId}`);
        const base = {
          jobId: job.id, type: job.type, keyword: job.keyword, status: job.status,
          createdAt: job.createdAt, updatedAt: job.updatedAt,
          stage: job.stage ?? null, progressPercent: job.progress ?? null,
          attempt: job.attempt ?? 1, heartbeatAt: job.heartbeatAt ?? null,
          resumable: job.resumable ?? false,
          error: job.error === "stale_timeout" ? "The job produced nothing for 20 minutes — the server most likely restarted mid-run. Any pages it had already finished are still in the result below." : job.error,
        };

        // A rewrite batch reports progress even while running, because its pages are
        // persisted one by one. Returning them mid-run is the whole point: work already
        // paid for should never be waiting on the rest of the batch to be readable.
        if (job.type === "rewrite") {
          const state = parseJson(job.result) as any;
          if (!state?.pages) return { ...base, progress: { total: 0, completed: 0, failed: 0 }, pages: [], note: "The batch has not finished its first page yet." };

          const one = String(args.page ?? "").trim().toLowerCase();
          if (one) {
            const hit = state.pages.find((p: any) => String(p.url).toLowerCase().includes(one));
            if (!hit) throw new Error(`No page in this job matches "${one}". Finished so far: ${state.pages.map((p: any) => p.url).join(", ")}`);
            return { ...base, page: hit };
          }

          const withContent = args.includeContent === true;
          const danger = state.pages.filter((p: any) => p.factDrift?.severity === "danger").map((p: any) => p.url);
          return {
            ...base,
            progress: {
              total: state.total,
              completed: state.completed,
              failed: state.failed,
              remaining: Math.max(0, state.total - state.completed - state.failed),
              currentlyWorkingOn: state.inProgress,
            },
            pages: state.pages.map((p: any) => (withContent ? p : { ...p, content: undefined })),
            ...(danger.length ? {
              needsAttention: danger,
              warning: "These pages contain numbers or identifiers that are NOT in the source — invented values. Correct them before publishing; call get_generation_job with `page` to read one in full.",
            } : {}),
            ...(withContent ? {} : { note: "Rewritten text omitted — pass includeContent: true for all of it, or `page` for one." }),
          };
        }

        return { ...base, result: job.status === "completed" ? parseJson(job.result) : null };
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("Job not found")) throw e;
        return { count: 0, jobs: [], note: "SeoJob table not available on this instance (run: npx prisma db push)." };
      }
    },
  },
];
