import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { inspectUrls, parseIndexInspect } from "@/lib/indexing/inspect";
import { pickInspectBatch, type InspectRow } from "@/lib/indexing/queue";
import { indexingTablesMissing, quotaToday, remainingToday } from "@/lib/indexing/quota";
import { INSPECTION_DAILY_LIMIT } from "@/lib/indexing/types";

// POST /api/indexing/auto/run { siteId, limit? ≤ 200 } — the "check a batch now" button.
// Free (it draws on Google's URL Inspection quota, not on any paid key), right "act".
//
// This is the auto QUEUE triggered by hand: the batch comes from the same priority order the
// scheduler uses and the spend lands in the `auto` column, so it respects the daily budget —
// the manual "check these specific URLs" path stays on check-google and is not budget-capped.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body.siteId ?? "");
  const limit = Math.min(200, Math.max(1, Math.round(Number(body.limit ?? 50)) || 50));
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });

  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { siteId: true, indexInspect: true },
  });
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const settings = parseIndexInspect(site.indexInspect);
    const quota = await quotaToday(site.siteId);
    const remaining = await remainingToday(site.siteId, settings.dailyBudget);
    const n = Math.min(limit, remaining);

    if (n <= 0) {
      // Distinguish the two quiet stops so the panel can say which one it was.
      return NextResponse.json({
        inspected: 0, indexed: 0, notIndexed: 0, errors: 0,
        quota: { ...quota, limit: INSPECTION_DAILY_LIMIT },
        reason: quota.exhausted ? "quota_exhausted" : "budget_spent",
      });
    }

    const rows: InspectRow[] = await prisma.sitemapUrl.findMany({
      where: { siteId, inventoryStatus: "active" },
      select: {
        url: true, firstSeenAt: true, googleChecked: true, googleNextCheck: true,
        googleStatus: true, changeStatus: true, inventoryStatus: true, lastSeenAt: true,
      },
    });
    const batch = pickInspectBatch(rows, new Date(), n).map(c => c.url);
    const outcomes = await inspectUrls(userId, siteId, batch, { auto: true });

    const after = await quotaToday(site.siteId);
    return NextResponse.json({
      inspected: outcomes.filter(o => o.ok).length,
      indexed: outcomes.filter(o => o.indexed === true).length,
      notIndexed: outcomes.filter(o => o.indexed === false).length,
      errors: outcomes.filter(o => !o.ok).length,
      quota: { ...after, limit: INSPECTION_DAILY_LIMIT },
    });
  } catch (e) {
    if (indexingTablesMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
}
