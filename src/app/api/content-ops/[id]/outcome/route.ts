import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { contentOpsUserId, operationDto, ownedOperation, recordTransition } from "@/lib/contentOps/server";
import { startMeasurement, verifyLiveUrl } from "@/lib/contentOps/outcome";

/**
 * Close the loop after a merge: confirm the page is really serving, then attach it to the
 * measurement surfaces. Deliberately a manual action — a merged PR is not a deployment, and only
 * the operator knows when their build has actually shipped.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await contentOpsUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const operation = await ownedOperation(userId, id);
  if (!operation) return NextResponse.json({ error: "operation_not_found" }, { status: 404 });
  if (!["pr_merged", "live"].includes(operation.status)) return NextResponse.json({ error: "not_merged_yet" }, { status: 409 });
  if (!operation.targetUrl) return NextResponse.json({ error: "missing_target_url" }, { status: 400 });

  // Opt-in only: adding a keyword to the Rank Tracker starts paid SERP checks on a schedule.
  const body = await req.json().catch(() => ({}));
  const trackKeyword = body?.trackKeyword === true;

  const check = await verifyLiveUrl(operation.targetUrl);
  if (!check.ok) {
    await prisma.contentOperation.update({ where: { id }, data: { error: check.error } });
    return NextResponse.json({ error: "not_live_yet", check }, { status: 409 });
  }

  const liveAt = operation.liveAt ?? new Date();
  const measurement = await startMeasurement(userId, { id, targetUrl: operation.targetUrl, keyword: operation.keyword, liveAt }, { trackKeyword });

  await prisma.contentOperation.update({
    where: { id },
    data: {
      status: "measuring",
      liveAt,
      error: null,
      siteId: measurement.siteId ?? operation.siteId,
      trackedKeywordId: measurement.trackedKeywordId ?? operation.trackedKeywordId,
      indexingLinkedAt: measurement.indexingLinked ? new Date() : null,
      measurementStartedAt: new Date(),
      // A site the instance does not track means no GSC rows will ever arrive for this URL. The
      // operation still moves on, but the card says so instead of showing an empty chart forever.
      // Re-running this action must not reset a measurement already in flight: the baseline and
      // any captured checkpoint describe a window that has already passed.
      outcomeJson: operation.outcomeJson ?? JSON.stringify({ baseline: measurement.baseline, checkpoints: [] }),
    },
  });
  if (operation.status !== "live") await recordTransition(id, userId, operation.status, "live", "system:verified_live", { status: check.status });
  await recordTransition(id, userId, "live", "measuring", "system:measurement_started", {
    site: measurement.siteId, keywordTracked: !!measurement.trackedKeywordId, indexingLinked: measurement.indexingLinked,
  });

  return NextResponse.json({ check, measurement, operation: operationDto(await ownedOperation(userId, id)) });
}
