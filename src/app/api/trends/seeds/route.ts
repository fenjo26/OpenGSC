import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { addSeed, listSeeds, removeSeed, trendsSchemaMissing } from "@/lib/trends/store";
import { kickTrendsScheduler } from "@/lib/trends/scheduler";

// /api/trends/seeds (CONTRACT §4): GET read, POST/DELETE act. The seed chips of the radar —
// what Google suggest is asked about. Adding the first seed also wakes the daily loop so a
// fresh opt-in does not wait an hour for its first automatic pass.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") || "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    return NextResponse.json({ seeds: await listSeeds(userId, siteId) });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_load_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body?.siteId ?? "");
  const seed = String(body?.seed ?? "");
  if (!siteId || !seed.trim()) return NextResponse.json({ error: "site_and_seed_required" }, { status: 400 });

  try {
    const result = await addSeed(userId, siteId, seed, String(body?.lang ?? ""), String(body?.country ?? ""));
    if (result.ok) kickTrendsScheduler();
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_save_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body?.siteId ?? "");
  const seed = String(body?.seed ?? "");
  if (!siteId || !seed.trim()) return NextResponse.json({ error: "site_and_seed_required" }, { status: 400 });

  try {
    const deleted = await removeSeed(userId, siteId, seed);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (trendsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "trends_save_failed" }, { status: 500 });
  }
}
