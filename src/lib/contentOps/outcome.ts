import "server-only";
import { prisma } from "@/lib/prisma";
import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import {
  BASELINE_DAYS, DAY_MS, isCheckpointDue, OUTCOME_DAYS, parseOutcome, sameHost,
  summarizeRows, urlVariants, type OutcomeRecord, type OutcomeWindow,
} from "./outcomeMath";

export * from "./outcomeMath";

/**
 * Post-deploy outcome for one Content Operation.
 *
 * The point of this module is the last question an SEO workflow usually leaves unanswered: did the
 * published page actually do anything? It reads what the instance already collects — DailyMetric
 * rows from Search Console and RankCheck rows from the Rank Tracker — and never calls a paid API,
 * a provider or Google on its own. Nothing here publishes, submits or spends: linking the URL into
 * the Indexing tab is the furthest it goes, because the submit buttons there cost money and stay
 * the operator's decision.
 */

/** The operator's site whose property covers this URL, or null when the page is not on a tracked site. */
export async function resolveSiteForUrl(userId: string, targetUrl: string) {
  let origin: string;
  try { origin = new URL(targetUrl).origin; } catch { return null; }
  const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true, siteId: true } });
  return sites.find(site => sameHost(site.url, origin) || sameHost(site.siteId, origin)) ?? null;
}

async function measureWindow(siteId: string, targetUrl: string, from: Date, to: Date): Promise<OutcomeWindow> {
  const rows = await prisma.dailyMetric.findMany({
    where: { siteId, url: { in: urlVariants(targetUrl) }, date: { gte: from, lte: to } },
    select: { clicks: true, impressions: true, position: true },
  });
  return summarizeRows(rows);
}

async function rankAt(trackedKeywordId: string | null, at: Date): Promise<number | null> {
  if (!trackedKeywordId) return null;
  const check = await prisma.rankCheck.findFirst({
    where: { keywordId: trackedKeywordId, checkedAt: { lte: at }, position: { not: null } },
    orderBy: { checkedAt: "desc" },
    select: { position: true },
  });
  return check?.position ?? null;
}

export interface LiveCheck { ok: boolean; status: number | null; error: string | null }

/**
 * Confirm the merged page is actually reachable. A merged pull request is not a deployment: the
 * build can fail, the route can 404, the host can still be serving the old bundle. Only a real 200
 * moves the operation forward.
 */
export async function verifyLiveUrl(targetUrl: string): Promise<LiveCheck> {
  try {
    const response = await safeFetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      timeoutMs: 15_000,
      maxBytes: 512 * 1024,
      headers: { "User-Agent": "OpenGSC-ContentOps/1.0" },
    });
    return { ok: response.status === 200, status: response.status, error: response.status === 200 ? null : "unexpected_status" };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof SafeFetchError ? error.code : "network_error" };
  }
}

export interface MeasurementStart {
  siteId: string | null;
  trackedKeywordId: string | null;
  indexingLinked: boolean;
  baseline: OutcomeRecord["baseline"];
}

/**
 * Wire a live page into the measurement surfaces that already exist. Everything here is additive
 * and idempotent: re-running it links the same rows again rather than creating duplicates.
 */
export async function startMeasurement(userId: string, operation: {
  id: string; targetUrl: string | null; keyword: string; liveAt: Date | null;
}, options: { trackKeyword?: boolean } = {}): Promise<MeasurementStart> {
  const empty: MeasurementStart = { siteId: null, trackedKeywordId: null, indexingLinked: false, baseline: null };
  if (!operation.targetUrl) return empty;
  const site = await resolveSiteForUrl(userId, operation.targetUrl);
  if (!site) return empty;

  const liveAt = operation.liveAt ?? new Date();
  const baselineTo = new Date(liveAt.getTime() - DAY_MS);
  const baselineFrom = new Date(baselineTo.getTime() - BASELINE_DAYS * DAY_MS);
  const window = await measureWindow(site.id, operation.targetUrl, baselineFrom, baselineTo);
  const baseline = { ...window, from: baselineFrom.toISOString(), to: baselineTo.toISOString() };

  // The Indexing tab tracks URLs through SitemapUrl. Adding the row makes the new page visible to
  // the checks that are already free; the paid submit buttons stay untouched and manual.
  let indexingLinked = false;
  try {
    await prisma.sitemapUrl.upsert({
      where: { siteId_url: { siteId: site.id, url: operation.targetUrl } },
      update: { lastSeenAt: new Date() },
      create: { siteId: site.id, url: operation.targetUrl, sourceSitemap: "content-operations", changeStatus: "added" },
    });
    indexingLinked = true;
  } catch { /* inventory is a convenience here, not a precondition for measuring */ }

  // Rank tracking is NOT started automatically, and that is a cost decision rather than a
  // cautious one: the hourly rank scheduler checks every tracked keyword through the operator's
  // paid SERP provider. Creating a row here would quietly commit them to a recurring spend they
  // never approved. An already-tracked keyword is linked (free — it is being checked anyway), and
  // adding a new one stays an explicit click in the outcome card.
  let trackedKeywordId: string | null = null;
  const keyword = operation.keyword.trim().slice(0, 240);
  if (keyword) {
    try {
      const existing = await prisma.trackedKeyword.findFirst({
        where: { siteId: site.id, keyword },
        select: { id: true },
      });
      if (existing) trackedKeywordId = existing.id;
      else if (options.trackKeyword) {
        const created = await prisma.trackedKeyword.create({
          data: { siteId: site.id, keyword, device: "desktop", country: "us" },
          select: { id: true },
        });
        trackedKeywordId = created.id;
      }
    } catch { /* a rank-tracker row is optional; GSC metrics alone still answer the question */ }
  }

  return { siteId: site.id, trackedKeywordId, indexingLinked, baseline };
}

/**
 * Capture every checkpoint whose window has closed. Cheap enough to run on a list request: it is a
 * couple of local aggregate queries per measuring operation, and operations without a due window
 * are skipped before any query runs.
 */
export async function captureDueCheckpoints(userId: string): Promise<number> {
  const rows = await prisma.contentOperation.findMany({
    where: { userId, status: "measuring" },
    select: { id: true, targetUrl: true, liveAt: true, siteId: true, trackedKeywordId: true, outcomeJson: true },
    take: 50,
  });
  const now = Date.now();
  let captured = 0;

  for (const row of rows) {
    if (!row.targetUrl || !row.liveAt || !row.siteId) continue;
    const outcome = parseOutcome(row.outcomeJson);
    const done = new Set(outcome.checkpoints.map(item => item.day));
    const liveAt = new Date(row.liveAt);
    let changed = false;

    for (const day of OUTCOME_DAYS) {
      if (done.has(day)) continue;
      const windowEnd = new Date(liveAt.getTime() + day * DAY_MS);
      if (!isCheckpointDue(liveAt, day, new Date(now))) continue;
      const measured = await measureWindow(row.siteId, row.targetUrl, liveAt, windowEnd);
      outcome.checkpoints.push({
        day,
        capturedAt: new Date().toISOString(),
        from: liveAt.toISOString(),
        to: windowEnd.toISOString(),
        rank: await rankAt(row.trackedKeywordId, windowEnd),
        ...measured,
      });
      changed = true;
    }

    if (!changed) continue;
    outcome.checkpoints.sort((a, b) => a.day - b.day);
    const finished = OUTCOME_DAYS.every(day => outcome.checkpoints.some(item => item.day === day));
    await prisma.contentOperation.update({
      where: { id: row.id },
      data: {
        outcomeJson: JSON.stringify(outcome),
        lastMeasuredAt: new Date(),
        ...(finished ? { status: "completed" } : {}),
      },
    });
    if (finished) {
      await prisma.contentOperationEvent.create({
        data: { operationId: row.id, userId, fromStatus: "measuring", toStatus: "completed", note: "system:outcome_complete" },
      });
    }
    captured++;
  }
  return captured;
}
