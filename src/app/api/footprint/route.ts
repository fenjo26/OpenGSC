import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { footprintReport } from "@/lib/footprint/store";
import type { FootprintKind } from "@/lib/footprint/skeleton";

// GET /api/footprint?kind=title|h1|description&minSites=2&includeIgnored=1&publishedOnly=1
// (CONTRACT §4, read). The report behind the /footprint page and the get_footprints MCP tool.
// Free and local: audits + generation history, zero external requests. Table missing →
// 200 { notMigrated: true } so the page can say "run prisma db push" instead of a 500.

const KINDS = new Set<FootprintKind>(["title", "description", "h1"]);

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const kindParam = p.get("kind") ?? "title";
  const kind: FootprintKind = KINDS.has(kindParam as FootprintKind) ? (kindParam as FootprintKind) : "title";
  const minSitesRaw = parseInt(p.get("minSites") ?? "", 10);
  const minSites = Number.isFinite(minSitesRaw) ? Math.min(50, Math.max(2, minSitesRaw)) : undefined;

  try {
    const report = await footprintReport(userId, {
      kind,
      minSites,
      includeIgnored: p.get("includeIgnored") === "1" || p.get("includeIgnored") === "true",
      publishedOnly: p.get("publishedOnly") === "1" || p.get("publishedOnly") === "true",
    });
    return NextResponse.json(report);
  } catch (error) {
    console.warn("[footprint] report failed:", error);
    return NextResponse.json({ error: "footprint_report_failed" }, { status: 500 });
  }
}
