import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { backlinksNotMigrated } from "@/lib/backlinks/store";

// POST — queue PURCHASED donor pages that the xr pass found OUT of Google's index into the
// private indexer network (/indexer): the doorways will serve links to them for the crawlers
// to discover. Free (our own domains), the same IndexerQueue the /indexer page feeds by hand.
//
// The xr verdict is the gate: only xrStatus "not_indexed" donors are queued — a donor nobody
// has checked is unknown, not unindexed, and mass-queueing everything would bury the queue in
// guesses. Round-robin across the user's ACTIVE doorway domains, upsert per (domain, url):
// re-running the action re-exposes the same donors instead of duplicating rows.

const PER_CALL_CAP = 200;

export async function POST() {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const domains = await prisma.indexerDomain.findMany({
    where: { userId, status: "active" },
    select: { id: true, domain: true },
  });
  if (domains.length === 0) {
    return NextResponse.json({ error: "no_indexer_domains", message: "Add doorway domains in /indexer first." }, { status: 400 });
  }

  let donors: Array<{ id: string; urlFrom: string }>;
  try {
    donors = await prisma.siteBacklink.findMany({
      where: { purchaseProvider: { not: "" }, site: { userId }, xrStatus: "not_indexed" },
      select: { id: true, urlFrom: true },
      orderBy: { xrCheckedAt: "asc" }, // longest-out-of-index first
      take: PER_CALL_CAP,
    });
  } catch (e) {
    if (backlinksNotMigrated(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    throw e;
  }
  if (donors.length === 0) {
    return NextResponse.json({ ok: true, queued: 0, domains: domains.length, candidates: 0 });
  }

  let queued = 0;
  for (let i = 0; i < donors.length; i++) {
    const domain = domains[i % domains.length];
    try {
      // Upsert, never duplicate: a donor already queued on this doorway keeps its place in the
      // rotation (crawledAt exposure fairness lives in the indexer itself).
      await prisma.indexerQueue.upsert({
        where: { domainId_url: { domainId: domain.id, url: donors[i].urlFrom } },
        create: { domainId: domain.id, url: donors[i].urlFrom },
        update: {},
      });
      queued++;
    } catch { /* row-level failure: the rest of the batch still queues */ }
  }

  return NextResponse.json({ ok: true, queued, domains: domains.length, candidates: donors.length });
}
