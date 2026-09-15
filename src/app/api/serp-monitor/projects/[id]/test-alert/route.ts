// POST /api/serp-monitor/projects/[id]/test-alert — deliver the storm-alert message built on
// fabricated data, so the user can see in Telegram/Slack what a real storm notification looks
// like before the first storm ever fires. No AlertEvent row: a test is not an occurrence.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/team/workspace";
import { sendSerpmonTestAlert } from "@/lib/serpmon/alerts";
import { schemaMissing } from "@/lib/serpmon/store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWorkspace("act");
  if (!guard.ok) return guard.response;
  const { id } = await params;

  // Ownership check: the test goes out under the workspace owner's channels, but only for a
  // project that belongs to them (sendSerpmonTestAlert re-checks the same scope).
  let owned = false;
  try {
    const project = await prisma.serpProject.findFirst({ where: { id, userId: guard.ws.ownerId }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    owned = true;
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ notMigrated: true, ok: false });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const res = await sendSerpmonTestAlert(guard.ws.ownerId, id);
  return NextResponse.json(res);
}
