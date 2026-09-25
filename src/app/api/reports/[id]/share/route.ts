// N8 — the client link of one report. POST creates/rotates the token (any existing link
// dies with it), DELETE turns the link off. act: a link is a public door — a viewer must
// not be able to open one. The token grants access to THIS report's snapshots only, never
// to the site dashboard (CONTRACT §0.7).
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { disableShareToken, reportsSchemaMissing, rotateShareToken } from "@/lib/reports/store";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const res = await rotateShareToken(userId, id);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
    return NextResponse.json({ report: res.report });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] share rotate failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const res = await disableShareToken(userId, id);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.error === "not_found" ? 404 : 400 });
    return NextResponse.json({ report: res.report });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] share disable failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
