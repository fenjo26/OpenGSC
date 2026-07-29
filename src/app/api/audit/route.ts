import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runAudit } from "@/lib/audit/crawler";

// Site Audit — built-in crawler, no external APIs.
// POST /api/audit { siteId, maxPages? }  → start an audit (fire-and-forget), returns { id }
// GET  /api/audit?siteId=                → list audits for a site (latest first)

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const maxPages = Math.min(500, Math.max(10, parseInt(String(b.maxPages ?? 200), 10) || 200));

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // One running audit per site at a time.
  const running = await prisma.siteAudit.findFirst({ where: { siteId, status: "running" } });
  if (running) return NextResponse.json({ error: "already_running", id: running.id }, { status: 409 });

  // Ignore rules are passed straight into the run rather than stored on the row: they are a
  // per-run choice, and keeping them out of the schema means this needs no migration.
  const ignorePatterns = Array.isArray(b.ignorePatterns)
    ? b.ignorePatterns.map(String)
    : String(b.ignorePatterns ?? "").split(/[\n,]/);
  const skipDefaultIgnores = b.skipDefaultIgnores === true;

  const audit = await prisma.siteAudit.create({ data: { siteId, maxPages } });
  // Fire-and-forget: the promise keeps running in-process after the response is sent
  // (same pattern as /api/seo/jobs — see docs/ARCHITECTURE.md §1).
  runAudit(audit.id, { ignorePatterns, skipDefaultIgnores })
    .catch(err => console.error("[audit] run failed:", err));
  return NextResponse.json({ id: audit.id });
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;

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

  // A process restart mid-crawl would leave a phantom "running" row — auto-fail after 30 min.
  const stale = new Date(Date.now() - 30 * 60_000);
  await prisma.siteAudit.updateMany({
    where: { siteId, status: "running", startedAt: { lt: stale } },
    data: { status: "error", error: "timeout: audit did not finish (process restart?)", finishedAt: new Date() },
  });

  const audits = await prisma.siteAudit.findMany({
    where: { siteId },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: { id: true, status: true, startedAt: true, finishedAt: true, pagesCrawled: true, maxPages: true, summary: true, error: true },
  });
  return NextResponse.json({
    audits: audits.map(a => ({ ...a, summary: a.summary ? JSON.parse(a.summary) : null })),
  });
}
