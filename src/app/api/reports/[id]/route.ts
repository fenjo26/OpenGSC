// N8 — one report: read / update / delete. GET read, PATCH and DELETE act.
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { deleteReport, getReport, reportsSchemaMissing, updateReport, type ReportInput } from "@/lib/reports/store";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const report = await getReport(userId, id);
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ report });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] get failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  try {
    const res = await updateReport(userId, id, body as ReportInput);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
    return NextResponse.json({ report: res.report });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] update failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const ok = await deleteReport(userId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] delete failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
