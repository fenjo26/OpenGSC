import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { backlinksNotMigrated, readToxicityOverview, siteForRead } from "@/lib/backlinks/store";

// GET /api/backlinks/toxicity?siteId= — the toxicity overview for the site's own profile:
// niche (+ suggestion), donor distribution by level, the donor table (worst first) and the
// over-optimisation banner numbers. Read-only and free; the run lives in ./run.
// A share token reads the same overview (the site page's guest view) — the write routes below
// resolve the site by session only, so a guest can never trigger anything.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  const shareToken = searchParams.get("shareToken") ?? "";

  try {
    const site = await siteForRead(userId, siteId, shareToken);
    if (!site) return NextResponse.json({ error: userId ? "Site not found" : "Unauthorized" }, { status: userId ? 404 : 401 });
    return NextResponse.json(await readToxicityOverview(site.id));
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to create the tox* columns." });
    }
    console.error("[backlinks-toxicity] GET failed:", error);
    return NextResponse.json({ error: "toxicity_read_failed" }, { status: 500 });
  }
}
