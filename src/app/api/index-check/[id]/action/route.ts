import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { pauseRun, resumeRun, cancelRun } from "@/lib/indexing/checkQueue";

// Run actions: pause (the pump stops picking; the call in flight finishes), resume (refused
// while another run of the same user is active — one paid stream at a time), cancel (queued
// items skipped instantly, the in-flight call still lands — its money is already committed).

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "");

  try {
    if (action === "pause") {
      const ok = await pauseRun(userId, id);
      if (!ok) return NextResponse.json({ error: "not_active" }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    if (action === "resume") {
      const out = await resumeRun(userId, id);
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    if (action === "cancel") {
      const ok = await cancelRun(userId, id);
      if (!ok) return NextResponse.json({ error: "not_cancellable" }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "bad_action" }, { status: 400 });
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? "");
    if (/SerpCheck|does not exist|no such table|no such column/i.test(msg)) {
      return NextResponse.json({ notMigrated: true }, { status: 503 });
    }
    console.error("[index-check:action]", e);
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
