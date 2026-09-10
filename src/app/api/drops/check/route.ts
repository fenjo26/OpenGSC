import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { profileForDomain, registryAnswerable } from "@/lib/drops/registries";
import { countPendingAvailability, EXCLUDE_MAX, markUncheckableZones, retireUncheckableRows, parseCandidateFilter, pendingAvailabilityCandidates, recordAvailabilityResults, schemaMissing } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

/**
 * One slice of the availability stage — the same bounded-batch shape as the DNS pre-filter, and
 * for the same reasons, except that here the batch is bounded by wall-clock time, not row count.
 *
 * The DNS stage asks a resolver, which does not care. This one asks public registries: each zone
 * is walked one domain at a time with its own `minIntervalMs`, and a queue of 40 same-zone rows
 * is minutes, not milliseconds. The deadline (`DEADLINE_MS`) stops the walk well before the
 * proxy in front of the app answers 504 — the request returns its partial slice, `remaining`
 * still counts the rest, and the client simply asks for the next slice. Nothing is lost, only
 * deferred; the 504 this replaced lost the whole batch and looked like a dead button.
 */
const DEADLINE_MS = 35_000;
const DEFAULT_BATCH = 40;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const runId = typeof body?.runId === "string" && body.runId ? body.runId : undefined;
    const batch = Math.min(Math.max(Number(body?.batch) || DEFAULT_BATCH, 1), 200);
    const domains = Array.isArray(body?.domains)
      ? body.domains.filter((d: unknown): d is string => typeof d === "string").slice(0, 200)
      : undefined;
    // "Выбрать все по фильтру → проверить": the queue narrows to the same filter the table
    // reads with, so the promised selection is the checked set. Explicit ids take precedence —
    // the two shapes never travel together.
    const filter = !domains?.length && body?.filter && typeof body.filter === "object"
      ? parseCandidateFilter(body.filter as Record<string, unknown>)
      : undefined;
    // The holes the user punched in "выделить всё" travel with the filter, or the queue would
    // re-check exactly the rows he unchecked.
    const exclude = filter && Array.isArray(body?.exclude)
      ? body.exclude.filter((v: unknown): v is string => typeof v === "string")
      : undefined;
    if (exclude && exclude.length > EXCLUDE_MAX) {
      return NextResponse.json({ error: "too_many_exclusions", max: EXCLUDE_MAX }, { status: 400 });
    }

    // Catalogues flagged before `no_registry` existed still carry those rows in the pending
    // stages; retiring them here keeps the funnel counts honest without a migration.
    await retireUncheckableRows(userId);

    const pending = await pendingAvailabilityCandidates(userId, { runId, limit: batch, domains, filter, exclude });
    if (!pending.length) {
      const remaining = await countPendingAvailability(userId, runId, filter, exclude);
      return NextResponse.json({ checked: 0, available: 0, taken: 0, deferred: 0, uncheckable: 0, remaining, done: true });
    }

    // A zone with no registry that can answer (`.gr`) is skipped before the walk: every query
    // against it costs its minIntervalMs of silence and ends in the same error. The rows get a
    // named marker and a week off instead of riding the refusal backoff forever.
    const answerable: string[] = [];
    const uncheckable: string[] = [];
    for (const domain of pending) {
      const profile = profileForDomain(domain);
      (profile && registryAnswerable(profile) ? answerable : uncheckable).push(domain);
    }

    const [results, skippedCount] = await Promise.all([
      checkAvailabilityBatch(answerable, { deadlineMs: DEADLINE_MS }),
      markUncheckableZones(userId, uncheckable),
    ]);
    const written = await recordAvailabilityResults(userId, results);
    const remaining = await countPendingAvailability(userId, runId, filter, exclude);

    return NextResponse.json({
      checked: results.size,
      ...written,
      uncheckable: skippedCount,
      remaining,
      // `deferred` covers rate limits and errors: those rows keep their stage and come back on a
      // later pass. Reporting them separately is what stops "checked 40, decided 12" reading as
      // data loss.
      // `done` also comes back when a whole batch was deferred with no zone skipped — every
      // registry in it is throttled, and hammering them again in the same second would only
      // deepen the backoff. A batch of uncheckable-zone rows is the exception: marking them
      // shrank the queue, so the loop continues until nothing due is left.
      done: remaining === 0 || (written.decided === 0 && skippedCount === 0),
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
