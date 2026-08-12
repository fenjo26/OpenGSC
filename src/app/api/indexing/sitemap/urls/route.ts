import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

function parsedSyncDetail(detail: string | null): any | null {
  if (!detail?.trim().startsWith("{")) return null;
  try { return JSON.parse(detail); } catch { return null; }
}

// GET /api/indexing/sitemap/urls?siteDbId=...&page=1&limit=50&status=all&search=
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteDbId = searchParams.get("siteDbId") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(200, Math.max(10, parseInt(searchParams.get("limit") ?? "50", 10)));
  const statusFilter = searchParams.get("status") ?? "all";
  const search = searchParams.get("search") ?? "";

  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true, lastSitemapSync: true, sitemapUrl: true, crawlInterval: true, url: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const latestAudit = await prisma.siteAudit.findFirst({
    where: { siteId: siteDbId, status: "completed" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, finishedAt: true },
  });
  const auditPages = latestAudit
    ? await prisma.siteAuditPage.findMany({
        where: { auditId: latestAudit.id },
        select: { url: true, issues: true, httpStatus: true },
      })
    : [];
  const auditByUrl = new Map(auditPages.map(row => [row.url.replace(/\/$/, ""), row]));

  const where: any = { siteId: siteDbId };
  if (search) where.url = { contains: search };
  if (statusFilter === "indexed") {
    where.OR = [
      { googleStatus: { contains: "indexed" } },
      { neuralStatus: "indexed" },
      { xrStatus: "indexed" },
    ];
  } else if (statusFilter === "not_indexed") {
    where.AND = [
      { NOT: { googleStatus: { contains: "indexed" } } },
      { NOT: { neuralStatus: "indexed" } },
      { NOT: { xrStatus: "indexed" } },
      { OR: [{ googleStatus: { not: null } }, { neuralStatus: "not_indexed" }, { xrStatus: "not_indexed" }] },
    ];
  } else if (statusFilter === "not_checked") {
    where.googleStatus = null;
    where.neuralStatus = null;
    where.xrStatus = null;
  } else if (statusFilter === "neural_indexed") {
    where.neuralStatus = "indexed";
  } else if (statusFilter === "neural_not_indexed") {
    where.neuralStatus = "not_indexed";
  } else if (statusFilter === "inventory_active") {
    where.inventoryStatus = "active";
  } else if (statusFilter === "inventory_added") {
    where.changeStatus = "added";
  } else if (statusFilter === "inventory_changed") {
    where.changeStatus = { in: ["changed", "restored"] };
  } else if (statusFilter === "inventory_pending") {
    where.inventoryStatus = "pending_missing";
  } else if (statusFilter === "inventory_missing") {
    where.inventoryStatus = "missing";
  } else if (statusFilter === "lastmod_suspicious") {
    where.lastmodReliability = "suspicious";
  } else if (statusFilter === "audit_missing" && auditPages.length) {
    const variants = auditPages.flatMap(row => {
      const base = row.url.replace(/\/$/, "");
      return [base, `${base}/`];
    });
    where.NOT = { url: { in: [...new Set(variants)] } };
  }

  const [total, rows, allRows, latestSyncOperation] = await Promise.all([
    prisma.sitemapUrl.count({ where }),
    prisma.sitemapUrl.findMany({
      where,
      orderBy: [{ inventoryStatus: "asc" }, { firstSeenAt: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, url: true,
        sourceSitemap: true, sitemapType: true, lastmod: true, lastmodValid: true,
        imageCount: true, videoCount: true, newsCount: true,
        firstSeenAt: true, lastSeenAt: true, missingSyncs: true, inventoryStatus: true, changeStatus: true,
        contentType: true, contentHttpStatus: true, contentTitle: true, contentCheckedAt: true,
        lastmodReliability: true,
        googleStatus: true, googleCoverage: true, googleReason: true, googleChecked: true,
        xrStatus: true, xrChecked: true,
        twoIndexStatus: true, twoIndexAt: true,
        neuralStatus: true, neuralAt: true, neuralQueue: true,
        updatedAt: true,
      },
    }),
    prisma.sitemapUrl.findMany({
      where: { siteId: siteDbId },
      select: {
        url: true, googleStatus: true, xrStatus: true, twoIndexStatus: true, neuralStatus: true,
        inventoryStatus: true, changeStatus: true, lastmodReliability: true,
      },
    }),
    prisma.indexingOperation.findFirst({
      where: { siteId: siteDbId, type: "sitemap_sync" },
      orderBy: { createdAt: "desc" },
      select: { result: true, detail: true, createdAt: true },
    }),
  ]);

  const NEURAL_CHECK = new Set(["indexed", "not_indexed"]);
  const counters = {
    total: allRows.length,
    indexed: allRows.filter(row => /submitted and indexed/i.test(row.googleStatus ?? "") || row.neuralStatus === "indexed").length,
    notIndexed: allRows.filter(row => (row.googleStatus && !/submitted and indexed/i.test(row.googleStatus)) || row.neuralStatus === "not_indexed").length,
    notChecked: allRows.filter(row => !row.googleStatus && !NEURAL_CHECK.has(row.neuralStatus ?? "") && !row.xrStatus).length,
    neuralSubmitted: allRows.filter(row => row.neuralStatus === "submitted").length,
    neuralChecked: allRows.filter(row => NEURAL_CHECK.has(row.neuralStatus ?? "")).length,
    twoIndexSubmitted: allRows.filter(row => row.twoIndexStatus === "submitted").length,
    active: allRows.filter(row => row.inventoryStatus === "active").length,
    added: allRows.filter(row => row.changeStatus === "added").length,
    changed: allRows.filter(row => row.changeStatus === "changed" || row.changeStatus === "restored").length,
    pendingMissing: allRows.filter(row => row.inventoryStatus === "pending_missing").length,
    missing: allRows.filter(row => row.inventoryStatus === "missing").length,
    suspiciousLastmod: allRows.filter(row => row.lastmodReliability === "suspicious").length,
    auditCovered: allRows.filter(row => auditByUrl.has(row.url.replace(/\/$/, ""))).length,
  };

  const responseRows = rows.map(row => {
    const auditPage = auditByUrl.get(row.url.replace(/\/$/, ""));
    let issueCount = 0;
    if (auditPage?.issues) {
      try { issueCount = JSON.parse(auditPage.issues).length; } catch { /* legacy malformed row */ }
    }
    return {
      ...row,
      audit: auditPage ? { covered: true, issueCount, httpStatus: auditPage.httpStatus } : { covered: false, issueCount: 0, httpStatus: null },
    };
  });
  const latestSyncDetail = parsedSyncDetail(latestSyncOperation?.detail ?? null);

  return NextResponse.json({
    rows: responseRows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    counters,
    meta: {
      lastSitemapSync: site.lastSitemapSync,
      sitemapUrl: site.sitemapUrl,
      crawlInterval: site.crawlInterval,
      siteUrl: site.url,
      latestSync: latestSyncOperation ? {
        result: latestSyncOperation.result,
        createdAt: latestSyncOperation.createdAt,
        summary: latestSyncDetail?.summary ?? null,
        failures: latestSyncDetail?.failures ?? [],
        invalidExamples: latestSyncDetail?.invalidExamples ?? [],
      } : null,
      latestAudit: latestAudit ? { id: latestAudit.id, finishedAt: latestAudit.finishedAt, pages: auditPages.length } : null,
    },
  });
}
