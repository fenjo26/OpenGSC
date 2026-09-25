// N8 — "Send now": render the frozen snapshot, try the PDF, e-mail the recipients,
// notify the owner (reportSentMsg, event digest). act — it sends mail in the owner's name
// but spends nothing. The operator's UI language rides along so the owner's notification
// lands in the language they work in; clients always get the e-mail built by mail.ts.
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createAndSendRun, reportsSchemaMissing } from "@/lib/reports/store";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  try {
    const res = await createAndSendRun(userId, id, { send: true, lang: typeof body.lang === "string" ? body.lang : undefined });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
    return NextResponse.json(res);
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] send failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
