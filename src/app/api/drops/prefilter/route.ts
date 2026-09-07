import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { checkDnsBatch } from "@/lib/drops/dns";
import { countPendingDns, pendingDnsCandidates, recordDnsResults, schemaMissing } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

/**
 * One slice of the DNS pre-filter.
 *
 * Deliberately NOT "resolve the whole list". A 50 000-row run cannot be one request: it would
 * outlive any proxy timeout, report nothing until it finished, and lose everything already
 * resolved if it died in the middle. So the endpoint does a bounded batch, writes it back, and
 * reports what is left; the caller loops until `remaining` is 0. Each slice is durable on its
 * own, so closing the tab costs at most one batch.
 *
 * 200 × 40 in flight is roughly five waves of lookups. At the 5 s per-lookup ceiling that is a
 * ~25 s worst case and typically a second or two — comfortably inside a request, which is the
 * number the batch size is chosen from.
 */
const DEFAULT_BATCH = 200;
const CONCURRENCY = 40;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const runId = typeof body?.runId === "string" && body.runId ? body.runId : undefined;
    const batch = Math.min(Math.max(Number(body?.batch) || DEFAULT_BATCH, 1), 1000);

    const domains = await pendingDnsCandidates(userId, { runId, limit: batch });
    if (!domains.length) {
      return NextResponse.json({ checked: 0, retired: 0, advanced: 0, remaining: 0, done: true });
    }

    const results = await checkDnsBatch(domains, { concurrency: CONCURRENCY });
    const written = await recordDnsResults(
      userId,
      domains.map(domain => {
        const r = results.get(domain);
        return { domain, hasRecords: !!r?.hasRecords, nameServers: r?.nameServers ?? [] };
      }),
    );

    const remaining = await countPendingDns(userId, runId);
    return NextResponse.json({
      checked: domains.length,
      retired: written.retired,   // delegated → left the funnel, never asked at a registry
      advanced: written.advanced, // no delegation → goes on to the availability stage
      remaining,
      done: remaining === 0,
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
