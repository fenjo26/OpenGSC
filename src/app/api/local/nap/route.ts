import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getProfile, getSite, localSchemaMissing } from "@/lib/local/store";
import { runNapCheck } from "@/lib/local/runner";

// POST /api/local/nap { siteId } (act, net) — run the NAP check over the site's own pages.
// The report is returned, never stored (brief §2: "результат — отчёт на экране").

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string };
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  try {
    const site = await getSite(userId, siteId);
    if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    const profile = await getProfile(userId, siteId);
    if (!profile) return NextResponse.json({ error: "profile_required" }, { status: 400 });
    const report = await runNapCheck(profile, site.url);
    return NextResponse.json({ report });
  } catch (error) {
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] NAP check failed:", error);
    return NextResponse.json({ error: "nap_check_failed" }, { status: 500 });
  }
}
