import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";

// GET /api/audit/[id]?issue=broken_links — one audit with its pages (optionally filtered
// to pages carrying a given issue code). DELETE removes the audit and its pages.

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  const { id } = await ctx.params;

  // Owner session — or a valid share token belonging to the audited site (guest view).
  const shareToken = new URL(req.url).searchParams.get("shareToken") ?? "";
  const audit = userId
    ? await prisma.siteAudit.findFirst({ where: { id, site: { userId } }, include: { site: { select: { url: true } } } })
    : shareToken
      ? await prisma.siteAudit.findFirst({ where: { id, site: { shareToken, shareEnabled: true } }, include: { site: { select: { url: true } } } })
      : null;
  if (!audit) return NextResponse.json({ error: userId ? "Not found" : "Unauthorized" }, { status: userId ? 404 : 401 });

  const { searchParams } = new URL(req.url);
  const issue = searchParams.get("issue") ?? "";

  const pages = await prisma.siteAuditPage.findMany({
    where: { auditId: id, ...(issue ? { issues: { contains: `"${issue}"` } } : {}) },
    orderBy: [{ depth: "asc" }, { url: "asc" }],
    take: 1000,
  });

  return NextResponse.json({
    audit: {
      id: audit.id, status: audit.status, startedAt: audit.startedAt, finishedAt: audit.finishedAt,
      stage: audit.stage, progress: audit.progress, attempt: audit.attempt, heartbeatAt: audit.heartbeatAt,
      baselineAuditId: audit.baselineAuditId,
      verification: audit.verification ? JSON.parse(audit.verification) : null,
      pagesCrawled: audit.pagesCrawled, maxPages: audit.maxPages, error: audit.error,
      summary: audit.summary ? JSON.parse(audit.summary) : null, siteUrl: audit.site.url,
    },
    pages: pages.map(p => ({
      url: p.url, httpStatus: p.httpStatus, redirectTo: p.redirectTo, title: p.title,
      metaDescription: p.metaDescription, h1Count: p.h1Count, canonical: p.canonical,
      noindex: p.noindex, internalLinks: p.internalLinks, externalLinks: p.externalLinks,
      imagesNoAlt: p.imagesNoAlt, wordCount: p.wordCount, loadMs: p.loadMs, depth: p.depth,
      issues: p.issues ? JSON.parse(p.issues) : [],
      // Older audits have no evidence column value; the export falls back to deriving what it can.
      evidence: (p as any).evidence ? JSON.parse((p as any).evidence) : null,
      brokenLinks: p.brokenLinks ? JSON.parse(p.brokenLinks) : [],
    })),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const audit = await prisma.siteAudit.findFirst({ where: { id, site: { userId } } });
  if (!audit) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.siteAudit.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
