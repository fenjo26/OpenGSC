import { prisma } from "@/lib/prisma";
import { backlinksNotMigrated } from "@/lib/backlinks/store";
import { enqueueUrlsToDoorways } from "@/lib/indexer/enqueue";
import { orderOwner } from "@/lib/magiclinks/tracking";

// Purchased donor pages → the private indexer queue (/indexer). One selection layer shared by
// the global donors-indexer route, the per-order route and the MCP tool, so all three can never
// drift apart. The enqueue itself (round-robin, upsert) lives in lib/indexer/enqueue.
//
// Modes:
//  • { orderId }  — one order's donors, no cap (an order is a few hundred rows at most);
//  • { all: true } — every purchased donor NOT PROVEN indexed: covers never-checked donors too,
//    the zero-extra-steps path for fresh placements (oldest purchase first);
//  • default      — only donors the xr pass PROVED out of the index, longest-out first. A donor
//    nobody has checked is unknown, not unindexed — this mode never guesses.

export const DONORS_PER_CALL_CAP = 200;

export interface QueueDonorsSelection {
  orderId?: string;
  all?: boolean;
}

export type QueueDonorsResult =
  | { ok: true; queued: number; candidates: number; domains: number; capped: boolean; skippedIndexed: number }
  | { ok: false; reason: "no_indexer_domains" | "not_migrated" | "order_not_found" };

export async function queuePurchasedDonors(
  userId: string,
  sel: QueueDonorsSelection = {},
): Promise<QueueDonorsResult> {
  // Order mode resolves the owner first — a foreign orderId must read as "not found", not as
  // an empty list that answers ok:true queued:0.
  let siteId: string | null = null;
  if (sel.orderId) {
    const owner = await orderOwner(sel.orderId);
    if (!owner || owner.userId !== userId) return { ok: false, reason: "order_not_found" };
    siteId = owner.siteId;
  }

  const base = sel.orderId
    ? { siteId: siteId!, purchaseOrderId: sel.orderId }
    : { purchaseProvider: { not: "" }, site: { userId } };

  let donors: Array<{ urlFrom: string }>;
  let skippedIndexed = 0;
  try {
    [donors, skippedIndexed] = await Promise.all([
      prisma.siteBacklink.findMany({
        where: sel.all || sel.orderId
          ? { ...base, xrStatus: { not: "indexed" } } // not proven indexed (includes never-checked)
          : { ...base, xrStatus: "not_indexed" },     // proven out of the index only
        select: { urlFrom: true },
        orderBy: sel.all ? { addedAt: "asc" } : { xrCheckedAt: "asc" },
        take: sel.orderId ? undefined : DONORS_PER_CALL_CAP,
      }),
      prisma.siteBacklink.count({ where: { ...base, xrStatus: "indexed" } }),
    ]);
  } catch (e) {
    if (backlinksNotMigrated(e)) return { ok: false, reason: "not_migrated" };
    throw e;
  }

  const enqueued = await enqueueUrlsToDoorways(userId, donors.map(d => d.urlFrom));
  if (enqueued.domains === 0) return { ok: false, reason: "no_indexer_domains" };

  return {
    ok: true,
    queued: enqueued.queued,
    candidates: enqueued.candidates,
    domains: enqueued.domains,
    capped: !sel.orderId && donors.length === DONORS_PER_CALL_CAP,
    skippedIndexed,
  };
}
