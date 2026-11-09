import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { normDomain } from "@/lib/seo/backlinkStore";
import { readUsage } from "@/lib/seo/metricsStore";
import {
  loadCrawlgraphChanges, pollCrawlgraphGap, readCgExtras, resolveCrawlgraphCreds, submitCrawlgraphGap,
} from "@/lib/seo/crawlgraphBacklinks";

// POST /api/metrics/backlinks/crawlgraph { siteId, op, apiKey?, cap?, competitors?, from?, to? }
//
// The three Crawlgraph extras of the backlink profile (issue #40):
//   op "changes"    — added / removed / authority movement between the two newest quarterly
//                     snapshots, or an explicit from/to pair (1 call ≈ $0.019, cached);
//   op "gap_submit" — one competitor-gap job against 1–5 competitor domains (1 call, paid
//                     tier only — a free key answers 429 quota_exceeded, surfaced as-is);
//   op "gap_poll"   — poll the remembered job, free, until completed/failed (jobs live 7 days).
//
// The paid ops are explicit buttons that show their price first; polling and the initial load
// cost nothing. The target is the caller's own site row, never a request field — same rule as
// /api/metrics/backlinks.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const op = b.op === "changes" || b.op === "gap_submit" || b.op === "gap_poll" ? b.op : null;
  if (!op) return NextResponse.json({ error: "bad_op" }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const target = normDomain(String(site.url ?? "").replace(/^sc-domain:/, ""));
  if (!target) return NextResponse.json({ error: "bad_site_url" }, { status: 400 });

  const creds = await resolveCrawlgraphCreds(userId, b);
  if (!creds) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const cap = Number(b.cap ?? 0) || 0;

  if (op === "gap_poll") {
    const r = await pollCrawlgraphGap(target, creds);
    const body = {
      op,
      spentUnits: 0,
      crawlgraph: await readCgExtras(target),
      usage: await readUsage(userId, "crawlgraph"),
      ...(r.ok ? { result: r.job } : { error: r.error }),
    };
    return NextResponse.json(body, { status: r.ok ? 200 : r.error === "no_job" ? 400 : 502 });
  }

  if (op === "gap_submit") {
    const raw: unknown[] = Array.isArray(b.competitors) ? b.competitors : [];
    const competitors: string[] = raw
      .map((c: unknown) => String(c ?? "").trim().toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?/, "").split(/[/?#]/)[0])
      .filter((c: string) => c.includes("."));
    const unique = [...new Set(competitors)].filter(c => c !== target).slice(0, 5);
    if (!unique.length) return NextResponse.json({ error: "bad_competitors" }, { status: 400 });
    const r = await submitCrawlgraphGap(userId, target, creds, cap, unique);
    const body = {
      op,
      spentUnits: r.spentUnits,
      crawlgraph: await readCgExtras(target),
      usage: await readUsage(userId, "crawlgraph"),
      ...(r.ok ? { result: r.data } : { error: r.error, ...(r.wouldSpend ? { wouldSpend: r.wouldSpend } : {}) }),
    };
    return NextResponse.json(body, { status: r.ok ? 200 : r.error === "cap_exceeded" ? 429 : 502 });
  }

  const r = await loadCrawlgraphChanges(userId, target, creds, cap, {
    from: typeof b.from === "string" && b.from ? b.from : undefined,
    to: typeof b.to === "string" && b.to ? b.to : undefined,
  });
  const body = {
    op,
    spentUnits: r.spentUnits,
    crawlgraph: await readCgExtras(target),
    usage: await readUsage(userId, "crawlgraph"),
    ...(r.ok ? { result: r.data } : { error: r.error, ...(r.wouldSpend ? { wouldSpend: r.wouldSpend } : {}) }),
  };
  return NextResponse.json(body, { status: r.ok ? 200 : r.error === "cap_exceeded" ? 429 : 502 });
}
