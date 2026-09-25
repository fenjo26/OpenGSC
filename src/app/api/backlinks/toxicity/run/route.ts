import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { backlinksNotMigrated, DEEP_CHECK_MAX, recalcSiteToxicity } from "@/lib/backlinks/store";

// POST /api/backlinks/toxicity/run { siteId, limit? } — recalculate the site's whole profile.
// Local and free by default: markers, anchors, scripts, structure — no network. With `limit`
// (0 < limit ≤ 50) it ALSO deep-checks that many suspicious donors: a safeFetch of each donor's
// homepage, title + text fragment re-run through the same markers. That part is network (net),
// still free — no paid provider is involved, so there is no price to confirm.
// The manual run never fires the toxic_new alert: the operator is looking at the very screen
// the alert would describe, and the scheduler's per-day dedupe stays meaningful.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body.siteId ?? "");
  const limit = Math.max(0, Math.min(DEEP_CHECK_MAX, Number(body.limit ?? 0) || 0));
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const summary = await recalcSiteToxicity(site.id, { deepLimit: limit, notify: false });
    return NextResponse.json(summary);
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to create the tox* columns." });
    }
    if (String((error as Error)?.message) === "site_not_found") {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
    console.error("[backlinks-toxicity] run failed:", error);
    return NextResponse.json({ error: "toxicity_run_failed" }, { status: 500 });
  }
}
