import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { countPendingAvailability, pendingAvailabilityCandidates, recordAvailabilityResults, schemaMissing } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

/**
 * One slice of the availability stage — the same bounded-batch shape as the DNS pre-filter, and
 * for the same reasons, except that here the batch has to be much smaller.
 *
 * The DNS stage asks a resolver, which does not care. This one asks public registries, which do:
 * each zone is walked one domain at a time with its own `minIntervalMs` (1.2 s for .com, 10 s for
 * .gr), and only different zones run in parallel. A batch of 40 mixed domains is therefore tens
 * of seconds, not milliseconds — so it stays small enough to answer inside a request, and the
 * client loops.
 */
const DEFAULT_BATCH = 40;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const runId = typeof body?.runId === "string" && body.runId ? body.runId : undefined;
    const batch = Math.min(Math.max(Number(body?.batch) || DEFAULT_BATCH, 1), 200);

    const domains = await pendingAvailabilityCandidates(userId, { runId, limit: batch });
    if (!domains.length) {
      return NextResponse.json({ checked: 0, available: 0, taken: 0, deferred: 0, remaining: 0, done: true });
    }

    const results = await checkAvailabilityBatch(domains);
    const written = await recordAvailabilityResults(userId, results);
    const remaining = await countPendingAvailability(userId, runId);

    return NextResponse.json({
      checked: domains.length,
      ...written,
      remaining,
      // `deferred` covers rate limits and errors: those rows keep their stage and come back on a
      // later pass. Reporting them separately is what stops "checked 40, decided 12" reading as
      // data loss.
      done: remaining === 0 || written.decided === 0,
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
