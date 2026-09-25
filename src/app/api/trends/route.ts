import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listTrends, setDismissed, trendsSchemaMissing } from "@/lib/trends/store";

// GET /api/trends?siteId=&source=&limit= (CONTRACT §4, read) — the radar feed plus the site's
// seeds. Table missing → 200 { notMigrated: true }.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const siteId = p.get("siteId") || "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    return NextResponse.json(await listTrends(userId, siteId, {
      source: p.get("source") ?? undefined,
      limit: Number(p.get("limit")) || undefined,
    }));
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_load_failed" }, { status: 500 });
  }
}

// PATCH /api/trends { siteId, ids: string[], dismissed: boolean } (act) — hide rows from the
// radar (and bring them back). The operator's call, never automatic.
export async function PATCH(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return NextResponse.json({ error: "no_ids" }, { status: 400 });

  try {
    const updated = await setDismissed(userId, siteId, ids, body?.dismissed !== false);
    return NextResponse.json({ ok: true, updated });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_update_failed" }, { status: 500 });
  }
}
