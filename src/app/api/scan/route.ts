import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createScan, scanDto } from "@/lib/scanner/service";
import { requireWorkspace } from "@/lib/team/workspace";

function notMigrated(error: unknown): boolean {
  const value = error as any;
  return value?.code === "P2021" || /SiteScan.*(?:does not exist|no such table)/i.test(String(value?.message ?? ""));
}

// GET /api/scan — scan history for this workspace.
export async function GET() {
  const guard = await requireWorkspace("read");
  if (!guard.ok) return guard.response;
  try {
    const rows = await (prisma as any).siteScan.findMany({
      where: { userId: guard.ws.ownerId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ scans: rows.map((row: any) => scanDto(row)) });
  } catch (error) {
    if (notMigrated(error)) return NextResponse.json({ scans: [], notMigrated: true });
    return NextResponse.json({ error: "scan_list_failed" }, { status: 500 });
  }
}

// POST /api/scan — X-ray one domain. Costs nothing but a few HTTP requests, so "act" rather than
// "spend"; the paid metric lookups on the same screen keep their own confirmation.
export async function POST(req: Request) {
  const guard = await requireWorkspace("act");
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => ({}));
  const target = String(body?.url ?? "").trim();
  if (!target) return NextResponse.json({ error: "missing_url" }, { status: 400 });
  try {
    return NextResponse.json({ scan: await createScan(guard.ws.ownerId, target) }, { status: 201 });
  } catch (error) {
    if (notMigrated(error)) return NextResponse.json({ error: "scan_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "scan_failed" }, { status: 400 });
  }
}
