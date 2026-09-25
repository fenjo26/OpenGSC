import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { createOutreachProspect } from "@/lib/outreach/service";

// POST /api/aeo/cited-to-outreach  { siteId, domain } → { prospectId }
// Saves a domain the AI engines keep citing as an Outreach prospect, through the same
// server-side service the MCP tool `save_outreach_prospect` uses. Local write only.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const domain = String(b.domain ?? "").trim();
  if (!domain) return NextResponse.json({ error: "domain_required" }, { status: 400 });

  try {
    const { prospect } = await createOutreachProspect(userId, { domain });
    return NextResponse.json({ prospectId: prospect.id });
  } catch (e) {
    // The service throws stable codes ("prospect_domain_required", "invalid_source_url").
    const code = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 80);
    return NextResponse.json({ error: code || "outreach_failed" }, { status: 400 });
  }
}
