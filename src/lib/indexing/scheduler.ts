// T4 — the in-process loop that spends Google's free URL Inspection quota for sites whose
// auto-check is on (docs/tasks/wave-oct/T4-index-autocheck.md).
//
// Same skeleton as serpmon/scheduler.ts: setInterval from instrumentation.ts, a `running` flag
// against overlap, permanent disable when the T4 tables aren't migrated yet. Every external
// operation runs inside withCallContext so the Google calls land in the provider log under the
// site owner.
//
// Tick = 10 min, three jobs:
//   1. daily coverage: for every opted-in site, write today's IndexCoverageDaily row if it
//      doesn't exist yet (the first tick after 00:00 UTC; restart-safe because existence is
//      checked in the database, not in memory);
//   2. auto inspections: portion = ceil(remaining / 10-min-slots-left-before-midnight-PT),
//      capped at 100 per site per tick, so the day's quota smears across the day and a dropped
//      page is found within hours; sites of one owner are visited round-robin so one 5 000-URL
//      site cannot eat every tick;
//   3. loss alert: pages that flipped indexed → not-indexed with clicks in the last 28 days,
//      one notification per site per UTC day (AlertEvent dedupe).

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang, type NotifyLang } from "@/lib/notifyI18n";
import { rawQuery } from "@/lib/db/raw";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { withCallContext } from "@/lib/providerLog/context";
import { isIndexedCoverage, msUntilPacificMidnight, pickInspectBatch, statusIndexed, utcDayString } from "./queue";
import { indexingTablesMissing, remainingToday } from "./quota";
import { inspectUrls, parseIndexInspect } from "./inspect";
import { collectLosses } from "./status";

const TICK_MS = 10 * 60_000;          // the contract's 10-minute tick
const TICK_BUDGET_MS = 8 * 60_000;    // leave 2 min of the tick free; pacing alone is ≥1 s/URL
const FIRST_TICK_MS = 90_000;         // first pass shortly after boot, like the other loops
const PER_SITE_PER_TICK = 100;        // hard cap per site per tick, whatever the smear says
const COVERAGE_WINDOW_DAYS = 90;      // rows older than this are pruned by the coverage write

let started = false;
let running = false;
let disabled = false;
let kickQueued = false;
/** Rotates which owner/site a tick starts with — the round-robin fairness knob. */
let rrCursor = 0;

interface OptedInSite {
  id: string;
  userId: string;
  siteId: string; // the GSC property (quota ledger key)
  url: string;
  settings: ReturnType<typeof parseIndexInspect>;
}

async function optedInSites(): Promise<OptedInSite[]> {
  const sites = await prisma.site.findMany({
    where: { indexInspect: { not: null } },
    select: { id: true, userId: true, siteId: true, url: true, indexInspect: true },
  });
  return sites
    .map(s => ({ id: s.id, userId: s.userId, siteId: s.siteId, url: s.url, settings: parseIndexInspect(s.indexInspect) }))
    .filter(s => s.settings.on);
}

/** Today's IndexCoverageDaily row for one site, computed from its active SitemapUrl rows. */
async function writeDailyCoverage(site: OptedInSite, day: string): Promise<void> {
  const existing = await prisma.indexCoverageDaily.findUnique({
    where: { siteId_day: { siteId: site.id, day } },
    select: { day: true },
  });
  if (existing) return; // first tick after 00:00 UTC already wrote it

  const [total, grouped] = await Promise.all([
    prisma.sitemapUrl.count({ where: { siteId: site.id, inventoryStatus: "active" } }),
    prisma.sitemapUrl.groupBy({
      by: ["googleCoverage", "googleVerdict", "googleStatus"],
      where: { siteId: site.id, inventoryStatus: "active" },
      _count: { _all: true },
    }),
  ]);

  let indexed = 0;
  let notIndexed = 0;
  const reasons = new Map<string, number>();
  for (const g of grouped) {
    const n = g._count._all;
    // Fresh rows carry (coverage, verdict); rows last inspected before T4 carry only the
    // combined googleStatus column. Unknown on both → unknown, never a guess.
    const verdict = isIndexedCoverage(g.googleCoverage ?? null, g.googleVerdict ?? null) ?? statusIndexed(g.googleStatus);
    if (verdict === true) indexed += n;
    else if (verdict === false) {
      notIndexed += n;
      const reason = g.googleCoverage ?? g.googleStatus ?? "unknown";
      reasons.set(reason, (reasons.get(reason) ?? 0) + n);
    }
  }
  const reasonsJson = JSON.stringify(
    Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v])),
  );

  await prisma.indexCoverageDaily.upsert({
    where: { siteId_day: { siteId: site.id, day } },
    create: { siteId: site.id, day, total, indexed, notIndexed, unknown: Math.max(0, total - indexed - notIndexed), reasons: reasonsJson },
    update: { total, indexed, notIndexed, unknown: Math.max(0, total - indexed - notIndexed), reasons: reasonsJson },
  });
  // Coverage is read as a 90-day series; trim the tail so one site can't grow it forever.
  await prisma.indexCoverageDaily.deleteMany({
    where: { siteId: site.id, day: { lt: utcDayString(new Date(Date.now() - COVERAGE_WINDOW_DAYS * 86_400_000)) } },
  }).catch(() => { /* prune is best-effort */ });
}

/** One site's auto batch for this tick, then the inspections themselves. */
async function runSiteBatch(site: OptedInSite, now: Date): Promise<number> {
  const remaining = await remainingToday(site.siteId, site.settings.dailyBudget);
  if (remaining <= 0) return 0;

  // Smear the day's remaining budget over the 10-minute slots left before the Pacific reset.
  const slots = Math.max(1, Math.ceil(msUntilPacificMidnight(now) / TICK_MS));
  const portion = Math.min(PER_SITE_PER_TICK, remaining, Math.ceil(remaining / slots));
  if (portion <= 0) return 0;

  const rows = await prisma.sitemapUrl.findMany({
    where: { siteId: site.id, inventoryStatus: "active" },
    select: {
      url: true, firstSeenAt: true, googleChecked: true, googleNextCheck: true,
      googleStatus: true, changeStatus: true, inventoryStatus: true, lastSeenAt: true,
    },
  });
  const batch = pickInspectBatch(rows, new Date(), portion).map(c => c.url);
  if (!batch.length) return 0;

  const captureBodies = await resolveCaptureBodies(site.userId);
  const outcomes = await withCallContext(
    { userId: site.userId, feature: "index-cron", captureBodies },
    () => inspectUrls(site.userId, site.id, batch, { auto: true }),
  );
  const ok = outcomes.filter(o => o.ok).length;
  const exhausted = outcomes.some(o => o.quotaExhausted);
  console.log(`[index-cron] ${site.url}: inspected ${ok}/${batch.length}${exhausted ? " (quota exhausted — stopping for today)" : ""}`);
  return ok;
}

/** The index-loss notification for one site (≤ 1 per UTC day via AlertEvent dedupe). */
async function deliverLossAlert(site: OptedInSite, utcDay: string): Promise<void> {
  if (!site.settings.alertOnLoss) return;
  const losses = (await collectLosses(site.id, 1, 200)).filter(l => l.clicks28d > 0);
  if (!losses.length) return;

  // The user's alert language, exactly as alertScheduler resolves it (saved from the UI).
  let lang: NotifyLang = "en";
  try {
    const rows = await rawQuery<{ alertSettings?: string | null }[]>(
      `SELECT alertSettings FROM "User" WHERE id = ?`, site.userId,
    );
    const raw = rows?.[0]?.alertSettings;
    lang = normalizeLang(raw ? JSON.parse(raw).lang : undefined);
  } catch { /* column/table missing → English */ }
  const L = NOTIFY_L[lang];

  const shown = losses.slice(0, 10).map(l => `${l.url} — ${l.coverageState ?? ""} — ${l.clicks28d}`);
  if (losses.length > 10) shown.push(L.digestMore(losses.length - 10));
  const title = L.indexLossTitle(site.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, ""));
  const message = L.indexLossMsg(
    site.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, ""),
    losses.length,
    shown.join("\n"),
  );

  const dedupeKey = `index_loss:${site.id}:${utcDay}`;
  try {
    await prisma.alertEvent.create({
      data: { userId: site.userId, type: "index_loss", siteId: site.id, title, message, dedupeKey },
    });
  } catch {
    return; // already alerted today — the dedupe is the whole point
  }
  const ok = await notifyUser(site.userId, `${title}\n\n${message}`, { event: "index" });
  if (ok) {
    await prisma.alertEvent.updateMany({ where: { userId: site.userId, dedupeKey }, data: { sent: true } });
  }
}

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  const deadline = Date.now() + TICK_BUDGET_MS;
  try {
    const now = new Date();
    const utcDay = utcDayString(now);
    const sites = await optedInSites();
    if (!sites.length) return;

    // 1. Daily coverage rows (cheap: one findUnique per site when today's row exists).
    for (const site of sites) {
      try { await writeDailyCoverage(site, utcDay); } catch (e) { console.warn(`[index-cron] coverage ${site.url} failed:`, e); }
    }

    // 2. Auto inspections. Round-robin: rotate the flattened site list so each tick starts
    // with a different site — with several big sites of one owner, no site monopolises ticks.
    // Grouping by owner is preserved implicitly: the list is interleaved by rotation, and
    // sequential inspection (one site at a time) means one owner's sites can't run in parallel
    // against the same per-minute pace anyway.
    const ordered = sites.map((_, i) => sites[(rrCursor + i) % sites.length]);
    rrCursor = (rrCursor + 1) % Math.max(1, sites.length);
    for (const site of ordered) {
      if (Date.now() >= deadline) break; // remaining sites get the next tick
      try {
        await runSiteBatch(site, new Date());
      } catch (e) {
        if (indexingTablesMissing(e)) throw e;
        console.warn(`[index-cron] batch ${site.url} failed:`, e);
      }
    }

    // 3. Loss alerts for today's transitions.
    for (const site of sites) {
      try { await deliverLossAlert(site, utcDay); } catch (e) { console.warn(`[index-cron] loss alert ${site.url} failed:`, e); }
    }
  } catch (e) {
    if (indexingTablesMissing(e)) {
      // Pulled-but-not-restarted instance: db push runs at container start.
      disabled = true;
      console.warn("[index-cron] InspectionQuota/IndexCoverageDaily tables missing — scheduler disabled until restart");
      return;
    }
    console.warn("[index-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startIndexScheduler(): void {
  if (started) return;
  started = true;
  console.log("[index-cron] scheduler started");
  setTimeout(tick, FIRST_TICK_MS);
  setInterval(tick, TICK_MS);
}

/**
 * Wake the loop now (after settings were saved or a manual batch ran) instead of waiting up to
 * 10 minutes. Coalesced like serpmon's kick: a burst queues exactly one immediate tick, and a
 * tick already in flight makes this a no-op.
 */
export function kickIndexScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}
