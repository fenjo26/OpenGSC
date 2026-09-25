// T4 — the URL Inspection API loop (docs/tasks/wave-oct/T4-index-autocheck.md).
//
// One function, inspectUrls, used by every path that actually calls Google: the scheduler's
// auto queue, the "check a batch now" button and the legacy manual check-google route. It
// walks the user's linked Google accounts until one can inspect the property, paces itself
// under INSPECTION_PER_MINUTE, counts every call in the quota ledger, and writes SitemapUrl,
// PageInspection and (on status change only) PageInspectionHistory.
//
// Every outbound call goes through loggedFetch with provider "google_url_inspection" and
// cost 0 — the API is free, it is quota-limited instead, and the provider log is where an
// operator goes to see what the queue did all day.

import { prisma } from "@/lib/prisma";
import { getUserGoogleAccounts, makeOAuth2, type GscAccount } from "@/lib/gscQuery";
import { loggedFetch } from "@/lib/providerLog/log";
import { isIndexedCoverage, nextCheckAt, utcDayStart } from "./queue";
import { quotaToday, recordInspections } from "./quota";
import {
  DEFAULT_INDEX_INSPECT, INSPECTION_PER_MINUTE,
  type IndexInspectSettings, type InspectOutcome,
} from "./types";

const INSPECT_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
/** Sequential calls with this spacing stay at INSPECTION_PER_MINUTE (Google allows 600/min). */
const PAUSE_MS = Math.ceil(60_000 / INSPECTION_PER_MINUTE);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Quota-error heuristic. gscSync.ts has the identical private isQuotaError (line ~61) but does
 * NOT export it, and gscSync is a frozen shared module this wave — so the heuristic is
 * duplicated here verbatim (429 or quota/rate-limit text in the message).
 */
function isQuotaError(status: number, message: string): boolean {
  return status === 429 || /quota|rate.?limit|too many requests/i.test(message);
}

/** 403 "you don't own this property" — the API's way of saying this account can't inspect it. */
function isOwnershipError(status: number, message: string): boolean {
  return status === 403 && /do not own|not part of this property|insufficient permissions/i.test(message);
}

/**
 * The siteUrl forms to try, native property id first. The URL Inspection API historically
 * rejected `sc-domain:` properties, which the legacy manual route worked around by sending the
 * https:// URL-prefix form instead; the API accepts sc-domain now, but a property verified only
 * as a domain may still answer differently per form — so both get a chance, cheapest-first
 * (the first form that works ends the attempt).
 */
export function inspectionSiteUrls(siteId: string): string[] {
  return siteId.startsWith("sc-domain:")
    ? [siteId, `https://${siteId.slice("sc-domain:".length)}/`]
    : [siteId];
}

/** Parse Site.indexInspect (JSON) with defensive clamping — the stored copy may predate T4. */
export function parseIndexInspect(raw: string | null | undefined): IndexInspectSettings {
  let s: Partial<IndexInspectSettings> = {};
  try { s = raw ? JSON.parse(raw) : {}; } catch { s = {}; }
  return {
    on: s.on === true,
    dailyBudget: Math.min(1800, Math.max(0, Math.round(Number(s.dailyBudget ?? DEFAULT_INDEX_INSPECT.dailyBudget)) || 0)),
    recheckIndexedDays: Math.min(365, Math.max(1, Math.round(Number(s.recheckIndexedDays ?? DEFAULT_INDEX_INSPECT.recheckIndexedDays)) || 1)),
    recheckNotIndexedDays: Math.min(365, Math.max(1, Math.round(Number(s.recheckNotIndexedDays ?? DEFAULT_INDEX_INSPECT.recheckNotIndexedDays)) || 1)),
    alertOnLoss: s.alertOnLoss !== false,
  };
}

interface ApiIndexStatus {
  verdict?: string | null;
  coverageState?: string | null;
  lastCrawlTime?: string | null;
  googleCanonical?: string | null;
  indexingState?: string | null;
  robotsTxtState?: string | null;
}

type SingleResult =
  | { kind: "ok"; r: ApiIndexStatus }
  | { kind: "quota" }
  | { kind: "ownership" }
  | { kind: "error"; detail: string };

/** Inspect one URL, trying each (siteUrl form × linked account) until one answers. */
async function inspectOne(url: string, siteUrls: string[], accounts: GscAccount[]): Promise<SingleResult> {
  let sawOwnership = false;
  let lastDetail = "inspection_failed";
  for (const account of accounts) {
    for (const siteUrl of siteUrls) {
      try {
        const oauth2 = makeOAuth2(account);
        const { token } = await oauth2.getAccessToken();
        if (!token) { lastDetail = "no_access_token"; continue; }
        const { res, call } = await loggedFetch(INSPECT_API, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionUrl: url, siteUrl }),
          signal: AbortSignal.timeout(15_000),
        }, { provider: "google_url_inspection" });
        const body = await res.json().catch(() => ({} as { error?: { message?: string } }));
        const message = String((body as { error?: { message?: string } }).error?.message ?? "");
        if (res.ok) {
          const r = (body as { inspectionResult?: { indexStatusResult?: ApiIndexStatus } }).inspectionResult?.indexStatusResult ?? {};
          call.finish({ status: res.status, responseBody: body });
          return { kind: "ok", r };
        }
        call.finish({ status: res.status, error: message || `HTTP ${res.status}`, responseBody: body });
        if (isQuotaError(res.status, message)) return { kind: "quota" };
        if (isOwnershipError(res.status, message)) { sawOwnership = true; continue; }
        lastDetail = `HTTP ${res.status}: ${message || "inspection_failed"}`.slice(0, 300);
        // any other failure (expired token that refused to refresh, 5xx…) → next form/account
      } catch (e) {
        lastDetail = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      }
    }
  }
  // Every reachable combination said "not yours" → an access problem, not a transient one.
  if (sawOwnership) return { kind: "ownership" };
  return { kind: "error", detail: lastDetail };
}

const failedOutcome = (url: string, error: string, quotaExhausted = false): InspectOutcome => ({
  url, ok: false, verdict: null, coverageState: null, indexed: null,
  lastCrawl: null, googleCanonical: null, error, quotaExhausted,
});

/**
 * Persist one successful inspection. PageInspectionHistory gets a row ONLY when the status
 * actually changed (unique [siteId, url, date] with date = UTC day start) — that table is the
 * loss-detection timeline, not an audit log of every check.
 */
async function persistInspection(
  siteDbId: string, url: string, r: ApiIndexStatus, settings: IndexInspectSettings, now: Date,
): Promise<InspectOutcome> {
  const verdict = r.verdict ?? null;
  const coverageState = r.coverageState ?? null;
  const status = coverageState ?? verdict ?? "UNKNOWN";
  const indexed = isIndexedCoverage(coverageState, verdict);
  const lastCrawl = r.lastCrawlTime ? new Date(r.lastCrawlTime) : null;
  const canonical = r.googleCanonical && r.googleCanonical !== url ? r.googleCanonical : null;
  const outcome: InspectOutcome = {
    url, ok: true, verdict, coverageState, indexed,
    lastCrawl: r.lastCrawlTime ?? null,
    googleCanonical: canonical, error: null, quotaExhausted: false,
  };

  const prev = await prisma.sitemapUrl.findUnique({
    where: { siteId_url: { siteId: siteDbId, url } },
    select: { googleStatus: true },
  });

  await prisma.sitemapUrl.upsert({
    where: { siteId_url: { siteId: siteDbId, url } },
    create: {
      siteId: siteDbId, url,
      googleStatus: status,
      googleCoverage: coverageState,
      googleReason: r.indexingState ?? null,
      googleChecked: now,
      googleVerdict: verdict,
      googleLastCrawl: lastCrawl,
      googleCanonical: canonical,
      googleNextCheck: nextCheckAt(outcome, settings, now),
    },
    update: {
      googleStatus: status,
      googleCoverage: coverageState,
      googleReason: r.indexingState ?? null,
      googleChecked: now,
      googleVerdict: verdict,
      googleLastCrawl: lastCrawl,
      googleCanonical: canonical,
      googleNextCheck: nextCheckAt(outcome, settings, now),
    },
  });

  // The Indexing tab reads this table (/api/gsc/inspect GET), so it stays in sync with the queue.
  await prisma.pageInspection.upsert({
    where: { siteId_url: { siteId: siteDbId, url } },
    create: { siteId: siteDbId, url, status, lastCrawl: lastCrawl },
    update: { status, lastCrawl: lastCrawl, lastInspect: now },
  }).catch(() => { /* the table predates T4 and is best-effort here */ });

  if (prev?.googleStatus !== status) {
    await prisma.pageInspectionHistory.upsert({
      where: { siteId_url_date: { siteId: siteDbId, url, date: utcDayStart(now) } },
      create: { siteId: siteDbId, url, date: utcDayStart(now), status },
      update: { status },
    }).catch(() => { /* best-effort: a missed history row delays one alert, nothing more */ });
  }

  return outcome;
}

/**
 * Inspect `urls` on one site, sequentially and paced. `opts.auto` decides which ledger column
 * the spend lands in (the auto budget share vs. free-form manual use).
 *
 * Short-circuits:
 *  - quota exhausted today → every URL comes back `{ quotaExhausted: true }` with no API call;
 *  - no linked Google account → `{ error: "no_google_account" }`;
 *  - the first URL's ownership/permission failure → the same error for the rest (the legacy
 *    manual route's "probe first" behaviour, kept so 200 URLs don't each burn a 403);
 *  - a 429 mid-run → the ledger is marked exhausted and every remaining URL gets
 *    `quotaExhausted: true` without calling Google again.
 */
export async function inspectUrls(userId: string, siteDbId: string, urls: string[], opts: { auto: boolean }): Promise<InspectOutcome[]> {
  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { siteId: true, indexInspect: true },
  });
  if (!site) throw new Error("site_not_found");

  const property = site.siteId;
  const settings = parseIndexInspect(site.indexInspect);
  const outcomes: InspectOutcome[] = [];

  const quota = await quotaToday(property);
  if (quota.exhausted) {
    return urls.map(u => failedOutcome(u, "quota_exhausted", true));
  }
  const accounts = await getUserGoogleAccounts(userId);
  if (!accounts.length) {
    return urls.map(u => failedOutcome(u, "no_google_account"));
  }
  const siteUrls = inspectionSiteUrls(property);

  let exhausted = false;
  let hardError: string | null = null; // ownership-style: pointless to try the remaining URLs
  let first = true;

  for (const url of urls) {
    if (exhausted) { outcomes.push(failedOutcome(url, "quota_exhausted", true)); continue; }
    if (hardError) { outcomes.push(failedOutcome(url, hardError)); continue; }
    if (!first) await sleep(PAUSE_MS);
    first = false;

    const result = await inspectOne(url, siteUrls, accounts);

    if (result.kind === "ok") {
      await recordInspections(property, 1, { auto: opts.auto });
      outcomes.push(await persistInspection(siteDbId, url, result.r, settings, new Date()));
    } else if (result.kind === "quota") {
      await recordInspections(property, 1, { auto: opts.auto, errors: 1, exhausted: true });
      exhausted = true;
      outcomes.push(failedOutcome(url, "quota_exhausted", true));
    } else if (result.kind === "ownership") {
      await recordInspections(property, 1, { auto: opts.auto, errors: 1 });
      hardError = "property_not_verified";
      outcomes.push(failedOutcome(url, hardError));
    } else {
      await recordInspections(property, 0, { auto: opts.auto, errors: 1 });
      outcomes.push(failedOutcome(url, result.detail));
    }
  }

  return outcomes;
}
