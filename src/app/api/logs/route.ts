import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma, dbAny } from "@/lib/prisma";
import { listServerLogs, resolveServerLog, storeImport, summarizeLogFile } from "@/lib/logs/importer";

export const dynamic = "force-dynamic";

// Server access logs (lib/logs) — owner only, never shared with a guest link.
// GET  /api/logs?siteId=       → this site's imports (newest first) + server files the operator
//                                allow-listed in OPENGSC_LOG_DIRS (empty list = feature off)
// POST /api/logs { siteId, path } → import a file from an allow-listed server directory
// Uploads from the browser go through /api/logs/upload in chunks.

async function ownSite(userId: string, siteId: string) {
  return siteId ? prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } }) : null;
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!(await ownSite(userId, siteId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rows: { id: string; createdAt: Date; source: string; lines: number; periodFrom: Date | null; periodTo: Date | null; googleHits: number }[] =
    await dbAny.serverLogImport.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, createdAt: true, source: true, lines: true, periodFrom: true, periodTo: true, googleHits: true },
    }).catch(() => []);
  return NextResponse.json({ imports: rows, serverFiles: await listServerLogs().catch(() => []) });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const siteId = String(b.siteId ?? "");
  if (!(await ownSite(userId, siteId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const file = await resolveServerLog(String(b.path ?? ""));
  if (!file) return NextResponse.json({ error: "path_not_allowed" }, { status: 400 });
  try {
    const summary = await summarizeLogFile(file);
    if (!summary.parsed) return NextResponse.json({ error: "no_log_lines", skipped: summary.skipped }, { status: 400 });
    const stored = await storeImport(siteId, file, summary);
    return NextResponse.json({ id: stored.id });
  } catch (e) {
    return NextResponse.json({ error: "import_failed", message: String((e as Error)?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
