import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseCrawlLog } from "@/lib/drops/crawlLog";
import { getAsset, recordCrawlLog } from "@/lib/drops/activationStore";
import { schemaMissing } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ domain: string }> };

/** One paste is one access log; beyond this the user is uploading the server, not measuring it. */
const MAX_LOG_CHARS = 10_000_000;

/**
 * POST /api/drops/activation/[domain]/crawl-log — the honest crawl measure for an
 * activated asset: paste the nginx access log of the asset host, get the Googlebot
 * summary written onto the asset (`lastGoogleHitAt`, `googleHits7d`). Manual by
 * design — the scheduled auto-recheck is a deliberate phase-2 cut until it is clear
 * what a good re-measure cadence even is.
 *
 * The parser is total, so garbage input can only ever produce a summary with
 * `skipped > 0` — never a 500. The last upload wins: `recordCrawlLog` overwrites,
 * so paste the freshest log, not a growing archive.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain: rawDomain } = await params;
    let domain = rawDomain;
    try {
      domain = decodeURIComponent(rawDomain);
    } catch {
      // A malformed escape in the path segment — fall through with the raw value;
      // the lookup is scoped by owner and will simply not match.
    }
    domain = domain.trim().toLowerCase();

    const found = await getAsset(userId, domain);
    if (!found) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const log = typeof body?.log === "string" ? body.log : "";
    if (!log.trim()) return NextResponse.json({ error: "empty_log" }, { status: 400 });
    if (log.length > MAX_LOG_CHARS) {
      return NextResponse.json({ error: "log_too_large", max: MAX_LOG_CHARS }, { status: 400 });
    }

    const summary = parseCrawlLog(log);
    await recordCrawlLog(userId, found.asset.id, {
      lastGoogleHitAt: summary.lastHitAt,
      googleHits7d: summary.hits7d,
    });
    return NextResponse.json({
      hitsTotal: summary.hitsTotal,
      hits7d: summary.hits7d,
      lastHitAt: summary.lastHitAt ? summary.lastHitAt.toISOString() : null,
      skipped: summary.skipped,
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
