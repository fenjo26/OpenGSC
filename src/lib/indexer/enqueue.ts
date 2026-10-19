import { prisma } from "@/lib/prisma";

// The one enqueue path every doorway-queue writer shares: the /indexer/queue page posts URLs by
// hand, and /magiclinks sends its purchased donor pages here (the donors-indexer route, the
// per-order route and the MCP tool all funnel into this). Round-robin across ACTIVE doorway
// domains, upsert per (domain, url): re-running an action re-exposes the same donors instead of
// duplicating queue rows — exposure fairness (oldest/never served first) lives in the indexer
// itself, not here.

export interface EnqueueResult {
  /** Rows created or re-confirmed by the upsert. */
  queued: number;
  /** URLs offered to the queue. */
  candidates: number;
  /** Active doorway domains the URLs were spread across (0 = none configured). */
  domains: number;
}

export async function enqueueUrlsToDoorways(userId: string, urls: string[]): Promise<EnqueueResult> {
  const domains = await prisma.indexerDomain.findMany({
    where: { userId, status: "active" },
    select: { id: true },
  });
  if (domains.length === 0) return { queued: 0, candidates: urls.length, domains: 0 };

  let queued = 0;
  for (let i = 0; i < urls.length; i++) {
    const domain = domains[i % domains.length];
    try {
      await prisma.indexerQueue.upsert({
        where: { domainId_url: { domainId: domain.id, url: urls[i] } },
        create: { domainId: domain.id, url: urls[i] },
        update: {},
      });
      queued++;
    } catch { /* row-level failure: the rest of the batch still queues */ }
  }
  return { queued, candidates: urls.length, domains: domains.length };
}
