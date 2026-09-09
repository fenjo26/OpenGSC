import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { flagDrSeries, readDrHistory } from "@/lib/seo/drHistory";

// GET /api/dr/history?domains=a.com,b.com — the panel's own monthly DR series (DrSnapshot),
// accumulated from every fresh DR measurement since the domain was first seen. This is the free
// counterpart of GoAnyAPI's paid dr-history: few or no points means "too early", not "no
// history exists". The veto flag applies the same −5 rule drops_dr_history uses.
// License: https://ahrefs.com/legal/domain-rating-license — "Domain Rating by Ahrefs"
// attribution is required wherever DR is displayed, history included.

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const shareToken = searchParams.get('shareToken');
  let isAuthorized = !!(await workspaceUserId());
  if (!isAuthorized && shareToken) {
    const site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true } });
    if (site) isAuthorized = true;
  }
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const domains = [...new Set(String(searchParams.get("domains") ?? "").split(",")
    .map(s => s.trim().toLowerCase().replace(/^www\./, "")).filter(d => d && d.includes(".")))].slice(0, 250);
  if (!domains.length) return NextResponse.json({ history: {}, flags: {} });

  const history = await readDrHistory(domains);
  const flags: Record<string, ReturnType<typeof flagDrSeries>> = {};
  for (const d of Object.keys(history)) flags[d] = flagDrSeries(history[d]);

  return NextResponse.json({
    history,
    flags,
    attribution: "Domain Rating by Ahrefs — https://ahrefs.com/",
  });
}
