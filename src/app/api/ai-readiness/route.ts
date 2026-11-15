import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runPart } from "@/lib/aiReady/run";
import { emptyReport, normAiDomain, readReport } from "@/lib/aiReady/store";

// AI Readiness (docs/tasks/ai-readiness/CONTRACT.md).
//
//   GET  /api/ai-readiness?siteId=…        the stored report (or an empty one) — no network
//   POST /api/ai-readiness { siteId, part } run one part: "access" | "presence" | "rank"
//
// Nothing here spends money: the parts read the site itself, Common Crawl's public index files
// and the public rank directory. The target is always the caller's own Site row — a domain in
// the request body is not accepted, so this cannot be pointed at an arbitrary host.

const PARTS = new Set(["access", "presence", "rank"]);

async function siteTarget(userId: string, siteId: string): Promise<{ domain: string; rootUrl: string } | null> {
  if (!siteId) return null;
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  if (!site) return null;
  const raw = String(site.url ?? "").trim();
  const domain = normAiDomain(raw);
  if (!domain || !domain.includes(".")) return null;
  // A URL-prefix property keeps its own scheme and host (www or not); a domain property and a
  // bare domain are probed over https at the apex.
  let rootUrl = `https://${domain}/`;
  if (/^https?:\/\//i.test(raw)) {
    try { rootUrl = `${new URL(raw).origin}/`; } catch { /* keep the https default */ }
  }
  return { domain, rootUrl };
}

export async function GET(req: Request) {
  const userId = await workspaceUserId("read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const target = await siteTarget(userId, new URL(req.url).searchParams.get("siteId") ?? "");
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const report = (await readReport(target.domain)) ?? emptyReport(target.domain);
  return NextResponse.json({ report });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const part = String(b?.part ?? "");
  if (!PARTS.has(part)) return NextResponse.json({ error: "bad_part" }, { status: 400 });
  const target = await siteTarget(userId, String(b?.siteId ?? ""));
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await runPart(target.domain, target.rootUrl, part as "access" | "presence" | "rank");
  if (!result.ok) {
    // The part failed as a whole (e.g. Common Crawl's crawl list was unreachable). Whatever was
    // stored before is returned untouched so the card keeps showing it.
    const report = (await readReport(target.domain)) ?? emptyReport(target.domain);
    return NextResponse.json({ error: result.error, report }, { status: 502 });
  }
  return NextResponse.json({ report: result.report });
}
