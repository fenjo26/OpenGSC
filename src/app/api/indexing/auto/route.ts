import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { indexAutoStatus, saveIndexInspect } from "@/lib/indexing/status";
import { indexingTablesMissing } from "@/lib/indexing/quota";
import { kickIndexScheduler } from "@/lib/indexing/scheduler";
import type { IndexInspectSettings } from "@/lib/indexing/types";

// Automatic URL Inspection settings + status (site → Indexing tab, CONTRACT.md §4).
// GET  ?siteId=  → IndexAutoStatus (+ sibling `noGoogle` flag for the panel's empty state)
// PUT  { siteId, settings } → save, wake the scheduler, return the refreshed status.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });

  try {
    const status = await indexAutoStatus(userId, siteId);
    if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // The panel swaps the form for idxAutoNoGoogle when no Google account is linked at all —
    // per-account property access can only be proven by an actual inspection, which the
    // run button will report on its own.
    const googleAccounts = await prisma.account.count({ where: { userId, provider: "google" } });
    return NextResponse.json({ ...status, noGoogle: googleAccounts === 0 });
  } catch (e) {
    if (indexingTablesMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body.siteId ?? "");
  if (!siteId || typeof body.settings !== "object" || body.settings === null) {
    return NextResponse.json({ error: "siteId and settings required" }, { status: 400 });
  }
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await saveIndexInspect(userId, siteId, body.settings as IndexInspectSettings);
    kickIndexScheduler(); // turning it on should start working within seconds, not next tick
    const status = await indexAutoStatus(userId, siteId);
    return NextResponse.json(status ?? { ok: true });
  } catch (e) {
    if (indexingTablesMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
}
