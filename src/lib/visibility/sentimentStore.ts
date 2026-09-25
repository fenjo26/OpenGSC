// N7 — storage side of answer sentiment: which stored answers are analysable, what a run will
// cost, and the run itself (one cheap LLM call per answer, on the user's configured provider).
//
// Money rules this file. Every analysis spends the user's AI credits, so: the count and the
// token estimate exist as a GET before anything runs; the run is a `spend`-right POST; already
// analysed answers are never re-analysed (the update refuses to touch a non-null sentiment);
// and the per-site auto toggle is OFF until somebody switches it on.
//
// The toggle has no column of its own in this wave's schema, so it lives in InstanceSetting
// under `aeoSentAuto:<siteId>` (absent = off). A proper Site column is on the request list for
// R — the key is one string, so migrating it later is a single UPDATE.

import { prisma } from "@/lib/prisma";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { hostOf, brandTermsFor } from "@/lib/seo/aeo";
import { parseBrandTerms } from "@/lib/aeoTracker";
import { getCompetitors } from "./store";
import { latestPerQuestionEngine, mentionsOf, sentimentDistribution, type SentimentSlice, type SovAnswer } from "./sov";
import { askSentiment, estimateSentimentTokens, type SentimentVerdict } from "./sentiment";
import type { AiCompetitor } from "./types";

export type SentimentScope = "us" | "all";

const RUN_LIMIT = 100;            // paid LLM calls per POST — the client loops while remaining > 0
const SCAN_CAP = 1000;            // window rows examined (they carry up to 12 kB of text each)
const AUTO_KEY = (siteId: string) => `aeoSentAuto:${siteId}`;

/** Prisma P2022 / SQLite "no such column" — the sentiment columns are new in this wave; an
 *  instance that pulled the code but skipped `npx prisma db push` gets `notMigrated`, not 500. */
export function sentimentSchemaMissing(e: unknown): boolean {
  const v = e as { code?: string; message?: string } | undefined;
  return v?.code === "P2022" || /sentiment(Score|Note)?\b.*(does not exist|no such column)/i.test(String(v?.message ?? ""));
}

// ─── the per-site auto toggle (default OFF) ───────────────────────────────────

export async function sentimentAutoEnabled(userId: string, siteId: string): Promise<boolean> {
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return false;
  try {
    const row = await prisma.instanceSetting.findUnique({ where: { key: AUTO_KEY(site.id) } });
    return row?.value === "1";
  } catch {
    return false; // no InstanceSetting table yet — the honest default is off
  }
}

export async function setSentimentAuto(userId: string, siteId: string, on: boolean): Promise<void> {
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) throw new Error("site_not_found");
  const key = AUTO_KEY(site.id);
  if (on) {
    await prisma.instanceSetting.upsert({ where: { key }, create: { key, value: "1" }, update: { value: "1" } });
  } else {
    // Off is also "absent" — deleting keeps the table from accreting rows nobody reads.
    await prisma.instanceSetting.deleteMany({ where: { key } });
  }
}

// ─── shared row shape ─────────────────────────────────────────────────────────

interface SentimentSiteCtx {
  host: string;
  ourTerms: string[];
  rivals: AiCompetitor[];
  language: string | null;
}

async function sentimentCtx(userId: string, siteId: string): Promise<SentimentSiteCtx | null> {
  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { url: true, brandedKeywords: true, aeoLanguage: true },
  });
  if (!site) return null;
  const host = hostOf(site.url);
  return {
    host,
    ourTerms: brandTermsFor(host, parseBrandTerms(site.brandedKeywords)),
    rivals: await getCompetitors(userId, siteId),
    language: site.aeoLanguage || null,
  };
}

const rivalTerms = (r: AiCompetitor): string[] => [r.name, ...r.terms, r.domain].filter(Boolean);

/** Rows that mention at least one target brand — what a scope="all" run would look at. */
function mentionsAnyTarget(text: string, ctx: SentimentSiteCtx): boolean {
  return mentionsOf(text, ctx.ourTerms) || ctx.rivals.some(r => mentionsOf(text, rivalTerms(r)));
}

interface CandidateRow {
  id: string;
  answerText: string | null;
  status: string | null;
  sentiment: string | null;
}

async function loadRows(
  siteId: string, from: Date, to: Date, scope: SentimentScope, ctx?: SentimentSiteCtx,
  opts: { onlyIds?: string[]; since?: Date } = {},
): Promise<CandidateRow[]> {
  const where: Record<string, unknown> = {
    question: { siteId },
    checkedAt: { gte: opts.since ?? from, lte: to },
    error: null,
    answerText: { not: null },
  };
  if (opts.onlyIds?.length) where.id = { in: opts.onlyIds };
  if (scope === "us") {
    where.status = { in: ["cited", "mentioned"] };
    where.sentiment = null; // already-analysed answers are never re-analysed
  }
  const rows = await prisma.aeoCheck.findMany({
    where,
    orderBy: { checkedAt: "desc" },
    take: SCAN_CAP,
    select: { id: true, answerText: true, status: true, sentiment: true },
  });
  // scope="all" looks at competitors too: keep every row that names any target brand. The scan
  // needs the text in memory (word-boundary matching), so it happens here, not in SQL — and the
  // same cap protects it.
  if (scope === "all" && ctx) return rows.filter(r => mentionsAnyTarget(r.answerText ?? "", ctx));
  return rows;
}

// ─── estimate (free, before any spend) ────────────────────────────────────────

export interface SentimentEstimate {
  windowDays: number;
  us: { pending: number; analysed: number; tokens: number };
  all: { answers: number; tokens: number };
}

export async function sentimentEstimate(userId: string, siteId: string, days: number): Promise<SentimentEstimate | null> {
  const ctx = await sentimentCtx(userId, siteId);
  if (!ctx) return null;
  const windowDays = [7, 30, 90].includes(days) ? days : 30;
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);

  const rows = await loadRows(siteId, from, to, "us");
  const analysed = await prisma.aeoCheck.count({
    where: { question: { siteId }, checkedAt: { gte: from, lte: to }, sentiment: { not: null } },
  }).catch(() => 0);
  const pending = rows.length;

  // The all-scope count needs the text in memory (mention detection is a word-boundary scan);
  // capped at SCAN_CAP like the run itself, so the estimate describes exactly what a run sees.
  const allAnswers = (await loadRows(siteId, from, to, "all", ctx)).length;

  return {
    windowDays,
    us: { pending, analysed, tokens: estimateSentimentTokens(pending) },
    all: { answers: allAnswers, tokens: estimateSentimentTokens(allAnswers) },
  };
}

// ─── the run (spend) ──────────────────────────────────────────────────────────

export interface SentimentRunResult {
  scope: SentimentScope;
  analysed: number;        // answers whose stored sentiment is now set
  examined: number;        // LLM calls actually made (a call that returns null still cost money)
  failed: number;          // calls that produced nothing usable
  remaining: number;       // candidates left for the next POST
  tokens: number;          // estimated spend of THIS call's examinations
  us: SentimentSlice | null;
  competitors: Record<string, SentimentSlice>;
}

function sliceFromVerdicts(verdicts: (SentimentVerdict | null)[]): SentimentSlice {
  const slice: SentimentSlice = { positive: 0, neutral: 0, negative: 0, mixed: 0, notAnalysed: 0 };
  for (const v of verdicts) {
    if (v) slice[v.sentiment] += 1;
    else slice.notAnalysed += 1;
  }
  return slice;
}

export async function runSentiment(
  userId: string, siteId: string, days: number, scope: SentimentScope,
  opts: { onlyIds?: string[]; since?: Date; limit?: number } = {},
): Promise<SentimentRunResult | null> {
  const ctx = await sentimentCtx(userId, siteId);
  if (!ctx) return null;
  const creds = await resolveAiCreds(userId, {}, "judge"); // the same per-task slot the QA judge uses
  if (!creds.aiApiKey) throw new Error("no_ai_key");

  const windowDays = [7, 30, 90].includes(days) ? days : 30;
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);
  const rows = await loadRows(siteId, from, to, scope, ctx, opts);
  const batch = rows.slice(0, Math.max(1, Math.min(RUN_LIMIT, opts.limit ?? RUN_LIMIT)));

  let analysed = 0;
  let examined = 0;
  let failed = 0;
  const compVerdicts = new Map<string, (SentimentVerdict | null)[]>();

  for (const row of batch) {
    // Targets for THIS answer: always us; in scope="all", every competitor it actually names.
    const targets = [{ name: ctx.host, terms: ctx.ourTerms }];
    const present = scope === "all" ? ctx.rivals.filter(r => mentionsOf(row.answerText ?? "", rivalTerms(r))) : [];
    for (const r of present) targets.push({ name: r.name, terms: rivalTerms(r) });

    examined += 1;
    const verdict = await askSentiment(
      { provider: creds.aiProvider, apiKey: creds.aiApiKey, model: creds.model, baseUrl: creds.aiBaseUrl },
      row.answerText ?? "",
      targets,
      ctx.language,
    );
    if (!verdict) {
      failed += 1;
      for (const r of present) compVerdicts.set(r.name, [...(compVerdicts.get(r.name) ?? []), null]);
      continue;
    }
    for (const r of present) compVerdicts.set(r.name, [...(compVerdicts.get(r.name) ?? []), verdict.competitors[r.name] ?? null]);

    if (verdict.target) {
      // The double condition is the "never re-analyse" rule at the write side too: even if two
      // runs overlap, the second write is refused where the first landed.
      const w = await prisma.aeoCheck.updateMany({
        where: { id: row.id, sentiment: null },
        data: { sentiment: verdict.target.sentiment, sentimentScore: verdict.target.score, sentimentNote: verdict.target.note || null },
      });
      if (w.count > 0) analysed += 1;
    }
  }

  // OUR distribution comes from the database (free aggregation over the whole window, including
  // rows earlier runs analysed); competitor verdicts have no column, so their distribution is
  // this run's answers only.
  const us = await freeUsDistribution(userId, siteId, windowDays, ctx);
  const competitors: Record<string, SentimentSlice> = {};
  for (const [name, list] of compVerdicts) competitors[name] = sliceFromVerdicts(list);

  return {
    scope,
    analysed,
    examined,
    failed,
    remaining: Math.max(0, rows.length - batch.length),
    tokens: estimateSentimentTokens(examined),
    us,
    competitors,
  };
}

/** Sentiment of our brand over the windowed latest answers — same numbers the free SOV GET
 *  shows, recomputed here so a run's response is immediately renderable. */
export async function freeUsDistribution(
  userId: string, siteId: string, windowDays: number, ctx?: SentimentSiteCtx,
): Promise<SentimentSlice | null> {
  const c = ctx ?? await sentimentCtx(userId, siteId);
  if (!c) return null;
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);
  const checks = await prisma.aeoCheck.findMany({
    where: { question: { siteId }, checkedAt: { gte: from, lte: to }, error: null },
    orderBy: { checkedAt: "desc" },
    take: 1000,
    select: { questionId: true, engine: true, checkedAt: true, answerText: true, status: true, sentiment: true },
  });
  const answers: SovAnswer[] = checks.map(x => ({
    questionId: x.questionId,
    question: "",
    engine: x.engine,
    checkedAt: x.checkedAt,
    answerText: x.answerText,
    citations: [],
    rank: null,
    status: x.status,
    sentiment: x.sentiment,
  }));
  // latest-per-pair inside the same window, so the slice matches what the SOV panel displays.
  return sentimentDistribution(latestPerQuestionEngine(answers, from, to), c.ourTerms);
}

// ─── the scheduler / manual-check hook ────────────────────────────────────────

/** What the aeoScheduler and the manual check route call after fresh answers landed: analyse
 *  them ONLY on sites where the operator switched the toggle on (it is off by default, and this
 *  function re-reads it every time rather than trusting a cached copy). Quiet by design — a
 *  background spend reports to the log, never throws into the caller's flow. */
export async function runAutoSentiment(
  userId: string, siteId: string, since: Date,
): Promise<{ ran: boolean; analysed: number; failed: number }> {
  if (!(await sentimentAutoEnabled(userId, siteId))) return { ran: false, analysed: 0, failed: 0 };
  try {
    const r = await runSentiment(userId, siteId, 1, "us", { since, limit: 50 });
    return { ran: true, analysed: r?.analysed ?? 0, failed: r?.failed ?? 0 };
  } catch (e) {
    // No AI key configured, a provider outage, or the sentiment columns not pushed yet — the
    // checks themselves already succeeded, and losing them over a tone measurement would be
    // the wrong trade. The reason goes to the log for the operator.
    console.warn(`[aeo-sentiment] auto pass failed for site ${siteId}:`, e instanceof Error ? e.message : e);
    return { ran: true, analysed: 0, failed: 0 };
  }
}
