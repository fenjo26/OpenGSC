import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  cancelQueuedAudits,
  retryFailedAudits,
  setAuditQueuePaused,
} from "@/lib/audit/queue";

// POST /api/audit/queue/action { action } — operator controls for the audit queue.
//   pause       — stop starting new audits (flights in progress still land)
//   resume      — lift a pause
//   cancel      — delete queued orders (never started, so not history)
//   retryFailed — requeue the latest failed audit per site

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "");

  switch (action) {
    case "pause":
      return NextResponse.json({ paused: (await setAuditQueuePaused(userId, true)).paused });
    case "resume":
      return NextResponse.json({ paused: (await setAuditQueuePaused(userId, false)).paused });
    case "cancel":
      return NextResponse.json({ cancelled: await cancelQueuedAudits(userId) });
    case "retryFailed":
      return NextResponse.json({ retried: await retryFailedAudits(userId) });
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
}
