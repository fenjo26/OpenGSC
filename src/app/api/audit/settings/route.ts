import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getAuditQueueSettings, saveAuditQueueSettings, kickAuditQueue } from "@/lib/audit/queue";
import { validateCron } from "@/lib/cron";

// GET  /api/audit/settings              → the workspace queue settings (defaults merged in)
// POST /api/audit/settings              → save them
//      { queue: { concurrency, defaultIntervalDays, scheduleHourUtc, defaultCron,
//                 retryAttempts, retryDelayMin } }
//      { siteId, site: { mode: "inherit" | "custom" | "off" | "cron", intervalDays?, cron? } }
//        — per-site scheduling override for one site. Both shapes can ride in one request.
//
// Cron expressions (5 fields, UTC) are validated here and on the client; the scheduler
// additionally treats an invalid stored expression as absent rather than guessing.

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
    if ("defaultCron" in b.queue) {
      const raw = String(b.queue.defaultCron ?? "").trim();
      if (raw) {
        const err = validateCron(raw);
        if (err) return NextResponse.json({ error: "invalid_cron", message: err }, { status: 400 });
      }
    }
    const current = await getAuditQueueSettings(userId);
    await saveAuditQueueSettings(userId, { ...current, ...b.queue, paused: current.paused });
  }

  if (b.siteId) {
    const siteId = String(b.siteId);
    const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true, auditSettings: true } });
    if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const rawMode = b.site?.mode;
    let payload: Record<string, unknown>;
    if (rawMode === "cron") {
      const expr = String(b.site?.cron ?? "").trim();
      const err = validateCron(expr);
      if (err) return NextResponse.json({ error: "invalid_cron", message: err }, { status: 400 });
      payload = { mode: "cron", cron: expr };
    } else {
      const mode = rawMode === "off" ? "off" : rawMode === "custom" ? "custom" : "inherit";
      const intervalDays = typeof b.site?.intervalDays === "number" && Number.isFinite(b.site.intervalDays)
        ? Math.min(365, Math.max(1, Math.round(b.site.intervalDays)))
        : undefined;
      payload = { mode, ...(mode === "custom" && intervalDays ? { intervalDays } : {}) };
    }

    // The auditSettings JSON also carries the scheduler's cron lastFire marker — merge,
    // never replace, and drop the fields the new mode doesn't use.
    let existing: Record<string, unknown> = {};
    try { existing = site.auditSettings ? JSON.parse(site.auditSettings) : {}; } catch { /* nothing to preserve */ }
    const next: Record<string, unknown> = { ...existing, ...payload };
    if (payload.mode !== "cron") delete next.cron;
    if (payload.mode !== "custom") delete next.intervalDays;
    await prisma.site.update({ where: { id: siteId }, data: { auditSettings: JSON.stringify(next) } });
  }

  kickAuditQueue();
  return NextResponse.json({ queue: await getAuditQueueSettings(userId) });
}
