import { prisma } from "@/lib/prisma";

// Redistribution un-sticks queue rows from doorway domains that stopped being crawled: the
// webhook serves only the rows of the domain a bot actually hits, so pages parked on a dead
// doorway sit pending forever. Moved rows are re-created on OTHER active doorways as fresh
// rows — status pending, crawledAt null — re-entering the serving rotation from zero.
//
// Scope: { domainId } empties one doorway (the "everything hung on one domain" case);
// no domainId reshuffles the user's whole queue. Shared by the /api/indexer/queue/redistribute
// route and the indexer_redistribute_queue MCP tool, so the two can never drift apart.

export interface RedistributeSelection {
  /** Empty one doorway's rows onto the others; absent = reshuffle the whole queue. */
  domainId?: string;
}

export type RedistributeResult =
  | {
      ok: true;
      /** Rows re-created on another doorway (source row deleted). */
      moved: number;
      /** URL already lived on the assigned target — source deleted, no new row created. */
      merged: number;
      /** No alternative target (e.g. the URL already sits on every active doorway) — row untouched. */
      kept: number;
      /** Extra copies of one URL across several doorways removed by the pass. */
      deduped: number;
      /** Distinct doorways that received at least one moved row. */
      domainsUsed: number;
    }
  | {
      ok: false;
      reason: "domain_not_found" | "no_indexer_domains" | "no_alternative_domains" | "nothing_to_move";
    };

// Rows move in transactions of this many URLs — bounded statements, no artificial cap on the
// total: a queue of any size is processed to the end.
const CHUNK = 500;

export async function redistributeQueue(
  userId: string,
  sel: RedistributeSelection = {},
): Promise<RedistributeResult> {
  const [activeDomains, scopedDomain] = await Promise.all([
    prisma.indexerDomain.findMany({
      where: { userId, status: "active" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    sel.domainId
      ? prisma.indexerDomain.findFirst({ where: { id: sel.domainId, userId }, select: { id: true } })
      : Promise.resolve(null as { id: string } | null),
  ]);
  if (sel.domainId && !scopedDomain) return { ok: false, reason: "domain_not_found" };
  if (activeDomains.length === 0) return { ok: false, reason: "no_indexer_domains" };

  // Domain scope never moves rows back onto the source — the point is to empty it.
  const targets = sel.domainId ? activeDomains.filter(d => d.id !== sel.domainId) : activeDomains;
  if (targets.length === 0) return { ok: false, reason: "no_alternative_domains" };

  const rows = await prisma.indexerQueue.findMany({
    where: sel.domainId ? { domainId: sel.domainId } : { domain: { userId } },
    select: { id: true, domainId: true, url: true },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return { ok: false, reason: "nothing_to_move" };

  // Target load starts at the rows that are NOT leaving: whole-queue scope moves everything
  // (every load starts at zero), domain scope only empties the source, which is never a target —
  // so there the loads are the doorways' current row counts.
  let totals = new Map<string, number>();
  if (sel.domainId) {
    const grouped = await prisma.indexerQueue.groupBy({
      by: ["domainId"],
      where: { domain: { userId } },
      _count: { _all: true },
    });
    totals = new Map(grouped.map(g => [g.domainId, g._count._all]));
  }
  const load = new Map<string, number>(
    targets.map(t => [t.id, sel.domainId ? (totals.get(t.id) ?? 0) : 0]),
  );

  // One URL may legitimately sit on several doorways (manual per-domain submissions). Every copy
  // is leaving in this pass, so collapse them first: the oldest copy is the row that moves, the
  // rest are just deleted (deduped). Without this, a copy could be assigned onto a domain
  // another copy is about to vacate — skipDuplicates would swallow the create and the follow-up
  // delete would drop the URL from the queue entirely.
  const copies = new Map<string, Array<{ id: string; domainId: string }>>();
  for (const r of rows) {
    const list = copies.get(r.url);
    if (list) list.push(r);
    else copies.set(r.url, [r]);
  }

  let kept = 0;
  let deduped = 0;
  const usedTargets = new Set<string>();
  const plans: Array<{ create?: { domainId: string; url: string }; deleteIds: string[] }> = [];

  let ordinal = 0;
  for (const [url, list] of copies) {
    const rep = list[0];
    const extraIds = list.slice(1).map(c => c.id);
    deduped += extraIds.length;

    // A URL never moves onto a domain it already sits on (whole-queue scope: those are exactly
    // its copies' domains; domain scope: the source is already excluded, and landing on another
    // existing copy is a legit merge, counted below).
    const forbidden = new Set(sel.domainId ? [] : list.map(c => c.domainId));
    const candidates = targets.filter(t => !forbidden.has(t.id));
    if (candidates.length === 0) {
      kept++;
      if (extraIds.length > 0) plans.push({ deleteIds: extraIds });
      continue;
    }

    // Least-loaded target wins; ties rotate with the pass ordinal so the spread stays even.
    let minLoad = Infinity;
    for (const c of candidates) minLoad = Math.min(minLoad, load.get(c.id) ?? 0);
    const atMin = candidates.filter(c => (load.get(c.id) ?? 0) === minLoad);
    const best = atMin[ordinal % atMin.length];
    load.set(best.id, minLoad + 1);
    usedTargets.add(best.id);
    plans.push({ create: { domainId: best.id, url }, deleteIds: [rep.id, ...extraIds] });
    ordinal++;
  }

  let moved = 0;
  let merged = 0;
  for (let i = 0; i < plans.length; i += CHUNK) {
    const chunk = plans.slice(i, i + CHUNK);
    const creates = chunk.flatMap(p => (p.create ? [p.create] : []));
    const deleteIds = chunk.flatMap(p => p.deleteIds);

    // Create before delete inside one transaction: the new row must exist before the source
    // disappears. SQLite has no createMany({ skipDuplicates }) (README §5), so read the exact
    // (doorway, url) pairs that already exist, split the creates into inserts vs merges, then
    // delete the sources. A merge is never a failure — the URL keeps a home either way.
    await prisma.$transaction(async tx => {
      if (creates.length > 0) {
        const existing = await tx.indexerQueue.findMany({
          where: { OR: creates.map(c => ({ domainId: c.domainId, url: c.url })) },
          select: { domainId: true, url: true },
        });
        const have = new Set(existing.map(e => `${e.domainId}\u0000${e.url}`));
        const fresh = creates.filter(c => !have.has(`${c.domainId}\u0000${c.url}`));
        if (fresh.length > 0) await tx.indexerQueue.createMany({ data: fresh });
        moved += fresh.length;
        merged += creates.length - fresh.length;
      }
      if (deleteIds.length > 0) {
        await tx.indexerQueue.deleteMany({ where: { id: { in: deleteIds } } });
      }
    }, { maxWait: 5_000, timeout: 30_000 });
  }

  return { ok: true, moved, merged, kept, deduped, domainsUsed: usedTargets.size };
}
