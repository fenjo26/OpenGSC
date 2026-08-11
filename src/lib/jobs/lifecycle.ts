import { prisma } from "@/lib/prisma";

const seoJobs = () => (prisma as any).seoJob;
export const SEO_JOB_STALE_MS = 20 * 60_000;

export async function touchSeoJob(jobId: string, data: { stage?: string; progress?: number; checkpoint?: unknown } = {}) {
  const progress = data.progress == null ? undefined : Math.min(100, Math.max(0, Math.round(data.progress)));
  await seoJobs().update({
    where: { id: jobId },
    data: {
      heartbeatAt: new Date(),
      ...(data.stage ? { stage: data.stage } : {}),
      ...(progress == null ? {} : { progress }),
      ...(data.checkpoint === undefined ? {} : { checkpoint: JSON.stringify(data.checkpoint) }),
    },
  });
}
export function withSeoJobHeartbeat<T>(jobId: string, work: Promise<T>, everyMs = 60_000): Promise<T> {
  const beat = setInterval(() => touchSeoJob(jobId).catch(() => { /* row removed or update in progress */ }), everyMs);
  (beat as any).unref?.();
  return work.finally(() => clearInterval(beat));
}

export async function failStaleSeoJobs(userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - SEO_JOB_STALE_MS);
  try {
    const result = await seoJobs().updateMany({
      where: {
        ...(userId ? { userId } : {}),
        status: "processing",
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      data: { status: "error", stage: "interrupted", error: "stale_timeout" },
    });
    return result?.count ?? 0;
  } catch {
    // During a rolling update the old client can briefly see a schema without lifecycle columns.
    // Preserve the old updatedAt-only sweep rather than failing the History endpoint.
    try {
      const result = await seoJobs().updateMany({
        where: { ...(userId ? { userId } : {}), status: "processing", updatedAt: { lt: cutoff } },
        data: { status: "error", error: "stale_timeout" },
      });
      return result?.count ?? 0;
    } catch { return 0; }
  }
}
