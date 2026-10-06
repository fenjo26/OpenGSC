// The меджики loop + weekly placement verification. Two jobs, one hourly tick, both free —
// the only network is our own HTTP to donor pages and the link providers' order endpoints:
//
//   1. Orders that still owe placements: poll the provider once, import publication URLs into
//      SiteBacklink, stop polling once the order is terminal (MagicPurchase.trackedAt). Opening
//      an order's detail in /magiclinks does the same thing immediately.
//   2. Stale placement checks: every SiteBacklink row whose last check is older than a week is
//      re-verified through the same runPlacementVerify the manual button uses. The events it
//      writes (lost / anchor_changed / rel_downgraded / target_changed) feed the existing
//      alertScheduler rules — there is no notify path of its own here.
//
// Same in-process pattern as the tox scheduler: started once from instrumentation, `running`
// against overlap, and the verify half permanently disables itself when the SiteBacklink tables
// are not pushed. The first check of any row is a baseline (diffCheckEvents emits nothing for
// "unchecked" → anything), so a fresh import can never arrive as a wall of false losses.

import { prisma } from "@/lib/prisma";
import { isVerifyRunning, runPlacementVerify } from "@/lib/seo/placementRunner";
import { backlinksNotMigrated } from "./store";
import { untrackedOrders, syncOrderPlacements } from "@/lib/magiclinks/tracking";

const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 15 * 60 * 1000; // after the data-bearing loops, like the tox scheduler
const STALE_AFTER_DAYS = 7;
const ORDERS_PER_TICK = 5;
const SITES_PER_TICK = 2;
const ROWS_PER_SITE = 60;

let started = false;
let running = false;
/** Set when the SiteBacklink tables are missing — the verify half stops retrying until restart. */
let verifyDisabled = false;

async function syncPendingOrders(): Promise<void> {
  const orders = await untrackedOrders(ORDERS_PER_TICK);
  for (const o of orders) {
    try {
      const res = await syncOrderPlacements(o.userId, o.provider, o.orderId);
      if (res && (res.imported || res.updated)) {
        console.log(`[ml-track] order ${o.orderId}: ${res.imported} placement(s) imported, ${res.updated} claimed`);
      }
    } catch (e) {
      console.warn(`[ml-track] order ${o.orderId} failed:`, (e as Error)?.message ?? e);
    }
  }
}

export interface StaleSiteGroup {
  siteId: string;
  /** the site's oldest stale check; null when some rows were never checked at all */
  oldest: Date | null;
  count: number;
}

/** Pure: never-checked sites first, then least-recently-checked — the queue drains fairly
 *  instead of hammering whichever site happens to sort first. */
export function pickStaleSites(groups: StaleSiteGroup[], limit: number): StaleSiteGroup[] {
  return [...groups]
    .sort((a, b) => {
      const av = a.oldest?.valueOf() ?? 0;
      const bv = b.oldest?.valueOf() ?? 0;
      if (av !== bv) return av - bv;
      return b.count - a.count;
    })
    .slice(0, limit);
}

async function verifyStale(): Promise<void> {
  if (verifyDisabled) return;
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);
  let groups: StaleSiteGroup[];
  try {
    const raw = await prisma.siteBacklink.groupBy({
      by: ["siteId"],
      where: { OR: [{ checkedAt: null }, { checkedAt: { lt: cutoff } }] },
      _count: { _all: true },
      _min: { checkedAt: true },
    });
    groups = raw.map(g => ({ siteId: g.siteId, oldest: g._min.checkedAt ?? null, count: g._count._all }));
  } catch (e) {
    if (backlinksNotMigrated(e)) {
      verifyDisabled = true;
      console.warn("[bl-verify-cron] SiteBacklink tables missing — verify half disabled until restart");
    }
    return;
  }

  for (const g of pickStaleSites(groups, SITES_PER_TICK)) {
    if (isVerifyRunning(g.siteId)) continue; // a manual run owns the site right now
    let ids: Array<{ id: string }>;
    try {
      ids = await prisma.siteBacklink.findMany({
        where: { siteId: g.siteId, OR: [{ checkedAt: null }, { checkedAt: { lt: cutoff } }] },
        select: { id: true },
        orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }],
        take: ROWS_PER_SITE,
      });
    } catch { continue; }
    if (!ids.length) continue;
    const sync = await prisma.siteBacklinkSync
      .create({
        data: { siteId: g.siteId, kind: "verify", status: "running", stage: "pull", progress: 0, heartbeatAt: new Date() },
      })
      .catch(() => null);
    if (!sync) continue;
    console.log(`[bl-verify-cron] site ${g.siteId}: re-checking ${ids.length} stale placement(s)`);
    void runPlacementVerify(sync.id, { siteId: g.siteId, ids: ids.map(r => r.id) })
      .catch(e => console.error("[bl-verify-cron] run crashed:", e));
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await syncPendingOrders();
  } catch (e) {
    console.warn("[ml-track] tick failed:", e);
  }
  try {
    await verifyStale();
  } catch (e) {
    console.warn("[bl-verify-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startBacklinkVerifyScheduler(): void {
  if (started) return;
  started = true;
  console.log("[bl-verify-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}
