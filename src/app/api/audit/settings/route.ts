import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getAuditQueueSettings, saveAuditQueueSettings, kickAuditQueue } from "@/lib/audit/queue";

// GET  /api/audit/settings              → the workspace queue settings (defaults merged in)
// POST /api/audit/settings              → save them
//      { queue: { concurrency, defaultIntervalDays, scheduleHourUtc, retryAttempts,
//                 retryDelayMin } }
//      { siteId, site: { mode: "inherit" | "custom" | "off", intervalDays? } } — per-site
//        scheduling override for one site. Both shapes can ride in one request.

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ queue: await getAuditQueueSettings(userId) });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));

  if (b.queue && typeof b.queue === "object") {
    // Merge onto the current settings: the client sends the whole block, but the paused
    // flag is owned by the pause/resume action, so an accidental client copy can't
    // silently unpause (or pause) the queue.
    const current = await getAuditQueueSettings(userId);
    await saveAuditQueueSettings(userId, { ...current, ...b.queue, paused: current.paused });
  }

  if (b.siteId) {
    const siteId = String(b.siteId);
    const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
    if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const mode = b.site?.mode === "off" ? "off" : b.site?.mode === "custom" ? "custom" : "inherit";
    const intervalDays = typeof b.site?.intervalDays === "number" && Number.isFinite(b.site.intervalDays)
      ? Math.min(365, Math.max(1, Math.round(b.site.intervalDays)))
      : undefined;
    await prisma.site.update({
      where: { id: siteId },
      data: { auditSettings: JSON.stringify({ mode, ...(mode === "custom" && intervalDays ? { intervalDays } : {}) }) },
    });
  }

  kickAuditQueue();
  return NextResponse.json({ queue: await getAuditQueueSettings(userId) });
}
