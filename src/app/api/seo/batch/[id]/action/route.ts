import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { pauseBatch, resumeBatch, cancelBatch, retryBatchFailures } from "@/lib/seo/genQueue/queue";

// POST /api/seo/batch/[id]/action — { action: "pause" | "resume" | "cancel" | "retry" }.
// The Batch page's buttons and the MCP batch_action tool land on the same
// handlers, so an agent and an operator see the same effects.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  let action = "";
  try { action = String((await req.json())?.action ?? ""); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  try {
    switch (action) {
      case "pause":
        await pauseBatch(userId, id);
        return NextResponse.json({ ok: true, action });
      case "resume":
        await resumeBatch(userId, id);
        return NextResponse.json({ ok: true, action });
      case "cancel": {
        const skipped = await cancelBatch(userId, id);
        return NextResponse.json({ ok: true, action, skipped });
      }
      case "retry": {
        const requeued = await retryBatchFailures(userId, id);
        return NextResponse.json({ ok: true, action, requeued });
      }
      default:
        return NextResponse.json({ error: "bad_action" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}
