// Detached execution of one SeoJob — the body every job starter shares.
//
// Extracted from POST /api/seo/jobs so the generation batch queue can run an
// item through the IDENTICAL path a browser-started or MCP-started job takes
// (call-context logging, capture-bodies setting, heartbeat, pre-flight ping,
// result filing into SeoHistory). The route re-exports it for its existing
// test import; new callers import it from here.

import { dbAny } from "@/lib/prisma";
import { genByType } from "@/lib/seo/generate";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { withCallContext } from "@/lib/providerLog/context";
import { touchSeoJob, withSeoJobHeartbeat } from "@/lib/jobs/lifecycle";
import { saveJobToHistory } from "@/lib/seo/historyServer";
import { pickLiveProvider } from "@/lib/seo/providerPing";

const jobs = () => dbAny.seoJob;

export interface SeoJobRow {
  id: string;
  type: string;
  keyword?: string;
  createdAt?: Date | string;
}

// Detached background run — not awaited by the caller, so the result persists
// even if the client navigates away or the process outlives the request. The
// promise is returned rather than swallowed so a test can await the detached
// work. Nothing else may await it in production paths, or the caller would
// once again live as long as the generation does, which is the whole point of
// detaching.
export async function runJob(userId: string, job: SeoJobRow, payload: Record<string, unknown>): Promise<void> {
  // Read here rather than in the caller: the setting belongs to the job's
  // owner, and this is the last moment there is an `await` to spend on it. A
  // generation that runs for half an hour keeps the answer it started with —
  // said out loud in the settings copy, so nobody is puzzled by bodies still
  // arriving after they switched capture off.
  const captureBodies = await resolveCaptureBodies(userId);
  // Inside the detached function, not around a request: the caller is answered
  // and gone long before `genByType` calls a provider, so there is no request
  // context left to inherit. The job knows its own owner and its own type,
  // which is what the log needs.
  return withCallContext({ userId, feature: String(job.type), captureBodies }, async () => {
    try {
      await touchSeoJob(job.id, { stage: "generating", progress: 5 });
      // Phase-level progress for pipelines that report it (genOutline et al read this from the
      // payload). Injected here rather than threaded through every signature: the function is
      // process-local, never serialized, and MCP's start_generation_job injects the same hook.
      payload.__onProgress = (progress: number, stage?: string) => {
        void touchSeoJob(job.id, { progress, ...(stage ? { stage } : {}) }).catch(() => {});
      };
      const r = await withSeoJobHeartbeat(job.id, (async () => {
        // Pre-flight ping: a dead pool fails here in seconds (or a configured fallback is
        // promoted) instead of grinding the whole chain into the wall-clock cap 25 minutes later.
        const picked = await pickLiveProvider(payload);
        if (!picked.ok) {
          return { ok: false as const, error: `provider_unreachable: ${picked.error} — the provider answered no pre-flight ping. Switch the model/provider for this task in SEO Tools → Settings.` };
        }
        // The payload is untyped JSON at the boundary; the generator's GenBody is not exported,
        // so take its parameter type here rather than re-declaring the whole shape.
        return genByType(String(job.type), payload as unknown as Parameters<typeof genByType>[1]);
      })());
      await jobs().update({
        where: { id: job.id },
        data: r.ok
          ? { status: "completed", stage: "completed", progress: 100, heartbeatAt: new Date(), result: JSON.stringify(r.data) }
          : { status: "error", stage: "error", heartbeatAt: new Date(), error: r.error },
      });
      // File the finished result into SeoHistory server-side: the record must exist even if
      // no browser tab ever imports the job row (id = job id, so a later import converges).
      if (r.ok) await saveJobToHistory(userId, job, r.data);
    } catch (e) {
      try {
        await jobs().update({
          where: { id: job.id },
          data: { status: "error", stage: "error", heartbeatAt: new Date(), error: String((e as Error)?.message ?? e) },
        });
      } catch { /* row removed */ }
    }
  });
}
