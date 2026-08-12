import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { collectSitemapInventory } from "@/lib/sitemap/inventory";
import { classifySeenEntry, planMissingTransitions } from "@/lib/sitemap/diff";

const SYNC_LOCK_MS = 10 * 60_000;
const WRITE_BATCH = 250;
const VALID_INTERVALS = new Set(["disabled", "daily", "weekly", "monthly"]);

async function inBatches<T>(items: T[], run: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < items.length; index += WRITE_BATCH) {
    await run(items.slice(index, index + WRITE_BATCH));
  }
}

// POST { siteDbId: string, sitemapUrl?: string, crawlInterval?: string }
//
// The original response keys (ok, total, sitemapUrl, syncedAt) are preserved. Inventory facts are
// additive, so older clients keep working while new clients can explain a partial run and its diff.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteDbId = String(body.siteDbId ?? "").trim();
  if (!siteDbId) return NextResponse.json({ error: "siteDbId required" }, { status: 400 });

  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true, url: true, sitemapUrl: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const requestedSitemap = String(body.sitemapUrl ?? "").trim() || site.sitemapUrl || "";
  const baseUrl = site.url.startsWith("http")
    ? site.url.replace(/\/$/, "")
    : `https://${site.url.replace(/^sc-domain:/, "").replace(/\/$/, "")}`;
  const targetSitemap = requestedSitemap || `${baseUrl}/sitemap.xml`;
  try {
    const parsed = new URL(targetSitemap);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid sitemap URL" }, { status: 400 });
  }

  // A DB-visible lock prevents a double click in one instance and usually also covers multiple
  // workers. It expires instead of becoming a permanent lock after a process restart.
  const running = await prisma.indexingOperation.findFirst({
    where: {
      siteId: siteDbId,
      type: "sitemap_sync",
      result: "running",
      createdAt: { gt: new Date(Date.now() - SYNC_LOCK_MS) },
    },
    select: { id: true },
  });
  if (running) return NextResponse.json({ error: "sync_running", operationId: running.id }, { status: 409 });

  const operation = await prisma.indexingOperation.create({
    data: { siteId: siteDbId, type: "sitemap_sync", result: "running", detail: targetSitemap, urlCount: 0 },
  });
  const syncToken = randomUUID();
  const now = new Date();

  let inventory;
  try {
    inventory = await collectSitemapInventory(targetSitemap);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    await prisma.indexingOperation.update({
      where: { id: operation.id },
      data: { result: "error", detail: JSON.stringify({ sitemapUrl: targetSitemap, error: message }), urlCount: 0 },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
  const existingRows = await prisma.sitemapUrl.findMany({
    where: { siteId: siteDbId },
    select: {
      id: true, url: true, sourceSitemap: true, sitemapType: true, lastmod: true, lastmodValid: true,
      imageCount: true, videoCount: true, newsCount: true, inventoryStatus: true, missingSyncs: true,
      contentHash: true, contentLastmod: true, lastmodReliability: true,
    },
  });
  const existing = new Map(existingRows.map(row => [row.url, row]));
  const seenUrls = new Set(inventory.entries.map(entry => entry.url));

  let added = 0;
  let changedCount = 0;
  let restored = 0;
  let unchanged = 0;

  await inBatches(inventory.entries, async batch => {
    await prisma.$transaction(batch.map(entry => {
      const previous = existing.get(entry.url);
      const changeStatus = classifySeenEntry(previous, entry);
      if (changeStatus === "added") added++;
      else if (changeStatus === "restored") restored++;
      else if (changeStatus === "changed") changedCount++;
      else unchanged++;

      const lastmodChanged = !!previous && previous.lastmod !== entry.lastmod;
      return prisma.sitemapUrl.upsert({
        where: { siteId_url: { siteId: siteDbId, url: entry.url } },
        create: {
          siteId: siteDbId,
          url: entry.url,
          sourceSitemap: entry.sourceSitemap,
          sitemapType: entry.sitemapType,
          lastmod: entry.lastmod,
          lastmodValid: entry.lastmodValid,
          imageCount: entry.imageCount,
          videoCount: entry.videoCount,
          newsCount: entry.newsCount,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenSync: syncToken,
          inventoryStatus: "active",
          changeStatus,
        },
        update: {
          sourceSitemap: entry.sourceSitemap,
          sitemapType: entry.sitemapType,
          lastmod: entry.lastmod,
          lastmodValid: entry.lastmodValid,
          imageCount: entry.imageCount,
          videoCount: entry.videoCount,
          newsCount: entry.newsCount,
          lastSeenAt: now,
          lastSeenSync: syncToken,
          missingSyncs: 0,
          inventoryStatus: "active",
          changeStatus,
          // Once lastmod changes, the old content observation cannot prove its reliability. The
          // explicit metadata verifier will compare the new page fingerprint with that baseline.
          ...(lastmodChanged && previous?.contentHash ? { lastmodReliability: "unknown" } : {}),
        },
      });
    }), { timeout: 60_000 });
  });

  const missingPlan = planMissingTransitions(existingRows, seenUrls, inventory.partial);
  if (!inventory.partial) {
    await inBatches(missingPlan.pendingIds, ids => prisma.sitemapUrl.updateMany({
      where: { id: { in: ids }, siteId: siteDbId },
      data: { missingSyncs: { increment: 1 }, inventoryStatus: "pending_missing", changeStatus: "pending_missing" },
    }));
    await inBatches(missingPlan.missingIds, ids => prisma.sitemapUrl.updateMany({
      where: { id: { in: ids }, siteId: siteDbId },
      data: { missingSyncs: { increment: 1 }, inventoryStatus: "missing", changeStatus: "missing" },
    }));
  }

  const interval = VALID_INTERVALS.has(String(body.crawlInterval)) ? String(body.crawlInterval) : undefined;
  await prisma.site.update({
    where: { id: siteDbId },
    data: {
      // Only a complete run can become the disappearance baseline and the official last sync.
      ...(!inventory.partial ? { lastSitemapSync: now } : {}),
      ...(requestedSitemap ? { sitemapUrl: requestedSitemap } : {}),
      ...(interval ? { crawlInterval: interval } : {}),
    },
  });

  const summary = {
    added,
    changed: changedCount,
    restored,
    unchanged,
    pendingMissing: missingPlan.pendingMissing,
    disappeared: missingPlan.disappeared,
    invalid: inventory.invalid,
    partial: inventory.partial,
    fetchedSitemaps: inventory.fetchedSitemaps,
  };
  const detail = {
    sitemapUrl: targetSitemap,
    summary,
    failures: inventory.failures.slice(0, 20),
    invalidExamples: inventory.invalidExamples,
  };
  await prisma.indexingOperation.update({
    where: { id: operation.id },
    data: {
      result: inventory.partial ? "partial" : "success",
      detail: JSON.stringify(detail),
      urlCount: inventory.entries.length,
    },
  });

  return NextResponse.json({
    ok: true,
    total: inventory.entries.length,
    sitemapUrl: targetSitemap,
    syncedAt: now.toISOString(),
    partial: inventory.partial,
    summary,
    failures: inventory.failures.slice(0, 20),
  });
  } catch (error) {
    console.error("[sitemap] inventory persistence failed", error);
    await prisma.indexingOperation.update({
      where: { id: operation.id },
      data: { result: "error", detail: JSON.stringify({ sitemapUrl: targetSitemap, error: "sync_persist_failed" }) },
    }).catch(() => {});
    return NextResponse.json({ error: "sync_persist_failed" }, { status: 500 });
  }
}
