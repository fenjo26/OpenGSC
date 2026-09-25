// N8 — white-label branding (User.reportBranding), shown in Settings → ReportBrandingCard.
// GET read; PUT act. The logo comes back to the card that uploaded it (a data-URL the
// operator chose); nothing secret lives here.
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getBranding, reportsSchemaMissing, saveBranding } from "@/lib/reports/store";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ branding: await getBranding(userId) });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] branding read failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const { branding, issues } = await saveBranding(userId, body?.branding ?? body);
    return NextResponse.json({ branding, issues });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] branding save failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
