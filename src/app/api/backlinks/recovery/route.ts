import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { backlinksNotMigrated, readRecovery, siteForRead } from "@/lib/backlinks/store";

// GET /api/backlinks/recovery?siteId= — the lost-link recovery table: every row the two
// witnesses call lost (apiLost / our check missing / retargeted / rel-downgraded), scored by
// what the link was worth and labelled with the action to take. Free, local, read-only.
// "Add to Outreach" posts to /api/outreach (the same server service the MCP
// save_outreach_prospect tool calls), not here.

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  const shareToken = searchParams.get("shareToken") ?? "";

  try {
    const site = await siteForRead(userId, siteId, shareToken);
    if (!site) return NextResponse.json({ error: userId ? "Site not found" : "Unauthorized" }, { status: userId ? 404 : 401 });
    const rows = await readRecovery(site.id);
    return NextResponse.json({ rows, total: rows.length });
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to create the SiteBacklink tables." });
    }
    console.error("[backlinks-recovery] GET failed:", error);
    return NextResponse.json({ error: "recovery_read_failed" }, { status: 500 });
  }
}
