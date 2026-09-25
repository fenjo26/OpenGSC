// T7 — storage side of AI share of voice: reads AeoCheck rows the tracker already wrote and
// Site.aeoCompetitors (JSON: AiCompetitor[]), and mines GSC DailyMetric for question ideas.
//
// Nothing here spends anything: no AI call, no quota, no fetch. That is the feature — the
// aggregation recomputes the entire stored history whenever the competitor list changes.

import { prisma } from "@/lib/prisma";
import { hostOf, brandTermsFor } from "@/lib/seo/aeo";
import { parseBrandTerms } from "@/lib/aeoTracker";
import { buildSovReport, buildCitedDomains, latestPerQuestionEngine, questionLike, sentimentDistribution, type SovAnswer, type SentimentSlice } from "./sov";
import type { AiCompetitor, CitedDomainRow, SovReport, SuggestedQuestion } from "./types";

const SOV_ROW_CAP = 5000;       // answerText is up to 12 kB a row — the window is bounded in rows
const MAX_COMPETITORS = 10;
const SUGGEST_HARD_CAP = 50;

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseCitations(raw: string | null): SovAnswer["citations"] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(c => c && typeof c === "object")
      .map(c => ({ url: String(c.url ?? ""), domain: String(c.domain ?? ""), title: String(c.title ?? "") }));
  } catch {
    return [];
  }
}

/** Prisma P2022 — the Site.aeoCompetitors column is missing, i.e. `npx prisma db push` has not
 *  run on this instance yet. Routes translate this to `{ notMigrated: true }` per the wave rules. */
export function sovSchemaMissing(e: unknown): boolean {
  const v = e as { code?: string; message?: string } | undefined;
  return v?.code === "P2022" || /aeoCompetitors.*(does not exist|no such column)/i.test(String(v?.message ?? ""));
}

/** Host-only normalization for the competitor domain: no scheme, no www, no path, no port. */
export function normalizeCompetitorDomain(raw: unknown): string {
  return hostOf(String(raw ?? ""));
}

/** Clamp + clean the list the UI sends. Invalid entries are dropped, the rest is capped at 10. */
export function sanitizeCompetitors(list: unknown): AiCompetitor[] {
  if (!Array.isArray(list)) return [];
  const out: AiCompetitor[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const name = String((raw as AiCompetitor).name ?? "").trim().slice(0, 80);
    if (!name) continue;
    const domain = normalizeCompetitorDomain((raw as AiCompetitor).domain);
    const terms = (Array.isArray((raw as AiCompetitor).terms) ? (raw as AiCompetitor).terms : [])
      .map(t => String(t ?? "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 10);
    out.push({ name, domain, terms });
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}

// ─── the report ───────────────────────────────────────────────────────────────

export async function sovForSite(
  userId: string, siteDbId: string, days: number,
): Promise<{ report: SovReport; cited: CitedDomainRow[]; sentiment: { us: SentimentSlice | null } } | null> {
  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId }, select: { url: true, brandedKeywords: true },
  });
  if (!site) return null;

  const windowDays = [7, 30, 90].includes(days) ? days : 30;
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);

  // One query, only the columns the aggregation reads. `error: null` keeps failed calls out —
  // a rate limit is not evidence that a brand stopped being mentioned. Rows WITHOUT answer text
  // are loaded too: a no_overview row stores none, and it must be able to retire its pair in
  // latestPerQuestionEngine. Everything else hollow is dropped there.
  const checks = await prisma.aeoCheck.findMany({
    where: {
      question: { siteId: siteDbId },
      checkedAt: { gte: from, lte: to },
      error: null,
    },
    orderBy: { checkedAt: "desc" },
    take: SOV_ROW_CAP,
    select: {
      questionId: true, engine: true, checkedAt: true, answerText: true,
      citations: true, rank: true, status: true, sentiment: true,
      question: { select: { question: true } },
    },
  });

  const answers: SovAnswer[] = checks.map(c => ({
    questionId: c.questionId,
    question: c.question.question,
    engine: c.engine,
    checkedAt: c.checkedAt,
    answerText: c.answerText && c.answerText.trim() ? c.answerText : null,
    citations: parseCitations(c.citations),
    rank: c.rank,
    status: c.status,
    sentiment: c.sentiment,
  }));

  // At the row cap the window shrinks to what actually fits; the oldest surviving row is the
  // honest lower bound, and the report carries it instead of claiming the full window was seen.
  const actualFrom = checks.length >= SOV_ROW_CAP && checks.length > 0
    ? checks[checks.length - 1].checkedAt
    : from;

  const host = hostOf(site.url);
  const terms = brandTermsFor(host, parseBrandTerms(site.brandedKeywords));
  const rivals = await getCompetitors(userId, siteDbId);

  const report = buildSovReport(answers, { host, terms }, rivals, actualFrom, to);
  // buildSovReport applies latest-per-pair itself; the cited rating takes the same filtered list.
  const latest = latestPerQuestionEngine(answers, actualFrom, to);
  const cited = buildCitedDomains(latest, { host }, rivals, 50);
  // Sentiment of OUR brand across the same windowed answers — free by construction: it reads
  // the columns the sentiment pass already wrote. Competitor sentiment has no column and is
  // therefore NOT here; it exists only in a paid run's response (see sentimentStore).
  const sentiment = { us: sentimentDistribution(latest, terms) };
  return { report, cited, sentiment };
}

// ─── competitors ──────────────────────────────────────────────────────────────

export async function getCompetitors(userId: string, siteDbId: string): Promise<AiCompetitor[]> {
  try {
    const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { aeoCompetitors: true } });
    if (!site?.aeoCompetitors) return [];
    const parsed = JSON.parse(site.aeoCompetitors);
    return Array.isArray(parsed) ? sanitizeCompetitors(parsed) : [];
  } catch {
    // A missing column (no db push yet) or a corrupt blob both mean "none configured" — the
    // report then simply runs without rivals instead of breaking the whole sub-tab.
    return [];
  }
}

export async function saveCompetitors(userId: string, siteDbId: string, list: AiCompetitor[]): Promise<void> {
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) throw new Error("site_not_found");
  const clean = sanitizeCompetitors(list);
  await prisma.site.update({
    where: { id: site.id },
    data: { aeoCompetitors: clean.length ? JSON.stringify(clean) : null },
  });
}

// ─── question ideas from GSC ──────────────────────────────────────────────────

export async function suggestQuestions(userId: string, siteDbId: string, limit: number): Promise<SuggestedQuestion[]> {
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true, aeoLanguage: true } });
  if (!site) return [];
  const cap = Math.min(SUGGEST_HARD_CAP, Math.max(1, Math.round(Number(limit) || 20)));

  const from = new Date(Date.now() - 28 * 86_400_000);
  // query='' is the date-only rollup row; page/query rows are web-only but the filter keeps the
  // intent explicit (a five-times-counted aggregate is the classic mistake here).
  const byQuery = await prisma.dailyMetric.groupBy({
    by: ["query"],
    where: { siteId: siteDbId, date: { gte: from }, query: { not: "" }, searchType: "web" },
    _sum: { impressions: true, clicks: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: 4000,
  });

  const tracked = new Set(
    (await prisma.trackedQuestion.findMany({ where: { siteId: siteDbId }, select: { question: true } }))
      .map(q => q.question.trim().toLowerCase()),
  );

  const kept = byQuery
    .filter(r => r.query && questionLike(r.query, site.aeoLanguage || ""))
    .filter(r => !tracked.has(r.query.trim().toLowerCase()))
    .slice(0, cap);
  if (!kept.length) return [];

  // The page to show next to an idea: the URL with the most impressions for that query.
  const pairs = await prisma.dailyMetric.groupBy({
    by: ["query", "url"],
    where: {
      siteId: siteDbId, date: { gte: from }, searchType: "web",
      query: { in: kept.map(k => k.query) }, url: { not: "" },
    },
    _sum: { impressions: true },
    orderBy: { _sum: { impressions: "desc" } },
  });
  const topPage = new Map<string, string>();
  for (const p of pairs) if (!topPage.has(p.query)) topPage.set(p.query, p.url);

  return kept.map(r => ({
    question: r.query,
    impressions28d: r._sum.impressions ?? 0,
    clicks28d: r._sum.clicks ?? 0,
    page: topPage.get(r.query) ?? null,
  }));
}
