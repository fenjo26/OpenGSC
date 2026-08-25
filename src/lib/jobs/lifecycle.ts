import { prisma } from "@/lib/prisma";

const seoJobs = () => (prisma as any).seoJob;
export const SEO_JOB_STALE_MS = 20 * 60_000;

// Absolute wall-clock caps by job type. The stale sweep below only catches a job whose
// heartbeat DIED (a restarted server); a job whose current step is wedged keeps beating every
// 60s forever, so "stale" can never fire — exactly the 40-minutes-at-5% outline hang. Each
// outbound call already has its own abort timeout, but a pipeline is a CHAIN of them
// (SERP → scrape → MAP per competitor → outline → enrichment → judge, each with up to 3
// attempts), and a half-dead gateway that accepts connections and never answers turns that
// chain into hours of invisible black-hole timeouts. Caps are deliberately generous — a real
// outline can take 10+ minutes on a slow provider, and a 20-page rewrite batch is
// legitimately over an hour — but they are BOUNDED, so a wedged job surfaces as an error the
// user can act on instead of "Генерация…" with no end.
const JOB_WALL_CLOCK_MS: Record<string, number> = {
  outline: 25 * 60_000,
  outline_auto: 35 * 60_000,
  text: 45 * 60_000,
  analysis: 20 * 60_000,
  landing: 30 * 60_000,
  cluster: 35 * 60_000,
  // Rewrite batches run up to 20 pages SEQUENTIALLY in one row and save each page's result
  // into that row as it finishes — killing the row mid-batch orphans pages already paid for,
  // so this cap is a zombie-killer only and must clear the worst legitimate run
  // (20 pages × several minutes each, slow gateway, retries, repair passes).
  rewrite: 180 * 60_000,
};
const JOB_WALL_CLOCK_DEFAULT_MS = 30 * 60_000;

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
  let killed = 0;
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
    killed += result?.count ?? 0;
  } catch {
    // During a rolling update the old client can briefly see a schema without lifecycle columns.
    // Preserve the old updatedAt-only sweep rather than failing the History endpoint.
    try {
      const result = await seoJobs().updateMany({
        where: { ...(userId ? { userId } : {}), status: "processing", updatedAt: { lt: cutoff } },
        data: { status: "error", error: "stale_timeout" },
      });
      killed += result?.count ?? 0;
    } catch { /* no lifecycle columns at all */ }
  }

  // Heartbeat-proof deadline: anything still processing past its type's wall clock is a
  // wedged chain, not a slow one. One OR-clause sweep so a single query covers every type.
  const now = Date.now();
  const knownTypes = Object.keys(JOB_WALL_CLOCK_MS);
  const overdue: any[] = knownTypes.map(type => ({ type, createdAt: { lt: new Date(now - JOB_WALL_CLOCK_MS[type]) } }));
  overdue.push({ type: { notIn: knownTypes }, createdAt: { lt: new Date(now - JOB_WALL_CLOCK_DEFAULT_MS) } });
  try {
    const result = await seoJobs().updateMany({
      where: { ...(userId ? { userId } : {}), status: "processing", OR: overdue },
      data: { status: "error", stage: "interrupted", error: "job_timeout: exceeded the wall-clock cap for this job type — the provider chain hung (each step has its own timeout, so this means repeated black-hole attempts). Try again, or switch the model/provider for this task in SEO Tools → Settings." },
    });
    killed += result?.count ?? 0;
  } catch { /* schema drift during rolling updates — the stale sweep above already ran */ }
  return killed;
}
