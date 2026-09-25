// N8 — the reports list + creation. GET read, POST act (CONTRACT §4).
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createReport, listReports, listSiteOptions, reportsSchemaMissing, smtpReady, type ReportInput } from "@/lib/reports/store";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [reports, sites, smtpConfigured] = await Promise.all([
      listReports(userId), listSiteOptions(userId), smtpReady(userId),
    ]);
    return NextResponse.json({ reports, sites, smtpConfigured });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ notMigrated: true, reports: [], sites: [] });
    console.warn("[reports] list failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await createReport(userId, body as ReportInput);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "site_not_found" ? 404 : 400 });
    return NextResponse.json({ report: res.report });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] create failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
