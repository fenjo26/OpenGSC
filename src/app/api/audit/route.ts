import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { recoverStaleAudits, runAudit } from "@/lib/audit/crawler";

// Site Audit — built-in crawler, no external APIs.
// POST /api/audit { siteId, maxPages? }  → start an audit (fire-and-forget), returns { id }
// GET  /api/audit?siteId=                → list audits for a site (latest first)

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  // Default: crawl the whole site. A client may still pass a smaller number (the advanced field),
  // but omitting it no longer means "stop at 200 pages and do not mention it".
  let maxPages = Math.min(5000, Math.max(10, parseInt(String(b.maxPages ?? 5000), 10) || 5000));

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // One running audit per site at a time.
  const running = await prisma.siteAudit.findFirst({ where: { siteId, status: "running" } });
  if (running) return NextResponse.json({ error: "already_running", id: running.id }, { status: 409 });

  const baselineAuditId = String(b.baselineAuditId ?? "").trim() || null;
  let baselineOptions: { ignorePatterns?: string[]; skipDefaultIgnores?: boolean; seedFromSitemap?: boolean } | null = null;
  if (baselineAuditId) {
    const baseline = await prisma.siteAudit.findFirst({
      where: { id: baselineAuditId, siteId, status: "completed" },
      select: { id: true, maxPages: true, options: true },
    });
    if (!baseline) return NextResponse.json({ error: "baseline_not_found" }, { status: 400 });
    if (b.maxPages == null) maxPages = baseline.maxPages;
    if (b.ignorePatterns == null && b.skipDefaultIgnores == null && baseline.options) {
      try { baselineOptions = JSON.parse(baseline.options); } catch { /* legacy row */ }
    }
  }

  // A verification run repeats the baseline's crawl scope unless the caller explicitly changes
  // it. That keeps a missing page from looking like a fix merely because exclusions changed.
  const options = baselineOptions ?? {
    ignorePatterns: Array.isArray(b.ignorePatterns)
      ? b.ignorePatterns.map(String)
      : String(b.ignorePatterns ?? "").split(/[\n,]/),
    skipDefaultIgnores: b.skipDefaultIgnores === true,
    seedFromSitemap: b.seedFromSitemap === true,
  };
  const audit = await prisma.siteAudit.create({
    data: {
      siteId,
      maxPages,
      stage: "crawl",
      progress: 0,
      heartbeatAt: new Date(),
      options: JSON.stringify(options),
      baselineAuditId,
    },
  });
  // Fire-and-forget: the promise keeps running in-process after the response is sent
  // (same pattern as /api/seo/jobs — see docs/ARCHITECTURE.md §1).
  runAudit(audit.id, options)
    .catch(err => console.error("[audit] run failed:", err));
  return NextResponse.json({ id: audit.id });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  // Owner session — or a valid share token for this exact site (read-only guest view).
  const shareToken = searchParams.get("shareToken") ?? "";
  const site = userId
    ? await prisma.site.findFirst({ where: { id: siteId, userId } })
    : shareToken
      ? await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true } })
      : null;
  if (!site) return NextResponse.json({ error: userId ? "Not found" : "Unauthorized" }, { status: userId ? 404 : 401 });

  // Free audits are safe to restart after a process crash. This claims stale rows atomically and
  // starts them again with their stored options; paid SEO jobs deliberately use a different policy.
  if (userId) await recoverStaleAudits(siteId);

  const audits = await prisma.siteAudit.findMany({
    where: { siteId },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: {
      id: true, status: true, stage: true, progress: true, attempt: true, heartbeatAt: true,
      baselineAuditId: true, verification: true, startedAt: true, finishedAt: true,
      pagesCrawled: true, maxPages: true, summary: true, error: true,
    },
  });
  return NextResponse.json({
    audits: audits.map(a => ({
      ...a,
      summary: a.summary ? JSON.parse(a.summary) : null,
      verification: a.verification ? JSON.parse(a.verification) : null,
    })),
  });
}
