import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { normDomain } from "@/lib/seo/backlinkStore";
import { readUsage } from "@/lib/seo/metricsStore";
import {
  importDataforseoHistory, loadDataforseoNewLost, readDfsExtras, resolveDataforseoCreds,
} from "@/lib/seo/dataforseoBacklinks";

// POST /api/metrics/backlinks/dataforseo { siteId, op, apiKey?, cap? }
//
// The two one-request DataForSEO extras of the backlink profile (issue #26):
//   op "history" — twelve monthly points of referring domains / backlinks into the snapshot
//                  series, so the trend has a past on the first day (≈ $0.0245);
//   op "newlost" — new and lost backlinks / domains per week for the last twelve weeks,
//                  cached so reopening the tab is free (≈ $0.0245).
// Both are explicit buttons that show their price first; neither runs on page load. The target
// is the caller's own site row, never a request field — same rule as /api/metrics/backlinks.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const op = b.op === "history" || b.op === "newlost" ? b.op : null;
  if (!op) return NextResponse.json({ error: "bad_op" }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const target = normDomain(String(site.url ?? "").replace(/^sc-domain:/, ""));
  if (!target) return NextResponse.json({ error: "bad_site_url" }, { status: 400 });

  const creds = await resolveDataforseoCreds(userId, b);
  if (!creds) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const cap = Number(b.cap ?? 0) || 0;

  const r = op === "history"
    ? await importDataforseoHistory(userId, target, creds, cap)
    : await loadDataforseoNewLost(userId, target, creds, cap);

  const body = {
    op,
    spentUnits: r.spentUnits,
    dataforseo: await readDfsExtras(target),
    usage: await readUsage(userId, "dataforseo"),
    ...(r.ok ? { result: r.data } : { error: r.error, ...(r.wouldSpend ? { wouldSpend: r.wouldSpend } : {}) }),
  };
  return NextResponse.json(body, { status: r.ok ? 200 : r.error === "cap_exceeded" ? 429 : 502 });
}
