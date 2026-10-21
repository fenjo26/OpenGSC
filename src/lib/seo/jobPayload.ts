// Server-side payload assembly for SEO Tools generation jobs — the ONE place
// that turns "what the caller asked for" into "what genByType accepts".
//
// Three callers need the identical resolution — the browser's POST
// /api/seo/jobs (via startJob), the MCP start_generation_job tool, and the
// generation batch queue — and the resolution has real money semantics:
// per-task AI creds, SERP creds, the active editorial policy, the judge slot
// and standby fallbacks. Keeping one copy here is not dedupe for its own sake;
// the SERP-key copy that drifted between two callers once silently broke a
// path, and a third copy would drift the same way. Anything a caller resolved
// itself (an explicit aiApiKey/policy in the payload) still wins.
//
// Items in the batch queue store KNOBS ONLY; the worker calls this function at
// run time, so keys rotated mid-batch apply to every item that has not run.

import { dbAny } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { coerceOutline } from "@/lib/mcp/outlineShape";
import { parseJson } from "@/lib/mcp/shared";
import {
  resolveAiCreds, resolveAiFallbacks, resolveSerpCreds, resolveActivePolicy, taskForJobType,
} from "@/lib/mcp/shared";

// The knob fields the /seo-tools form posts and the MCP tool hoists to top-level
// args. A batch item's payload carries the same names.
export const JOB_KNOBS = [
  "keyword", "language", "country", "tone", "promptType", "custom", "sourceMode",
  "includeToc", "targetWordCount", "temperature", "bannedWords", "judge",
  "chunkSections", "forbiddenBrands", "marksScrub",
] as const;

// Job types whose pipeline scrapes SERP competitors before touching the AI
// provider — they need serpCreds resolved and passed through.
const SERP_TYPES = new Set(["outline", "outline_auto", "landing", "cluster"]);

export interface ResolvedJobPayload {
  /** The payload for genByType: knobs + caller payload + resolved credentials. */
  payload: Record<string, unknown>;
}

/**
 * Resolve everything a generation job needs beyond its knobs: per-task AI creds
 * (throws when the instance has no key configured), SERP creds for the
 * SERP-scraping types, the active editorial policy, the judge slot and standby
 * provider fallbacks. `args` is the caller's JSON — knobs at the top level,
 * anything else under `args.payload`. Explicit credentials in args.payload
 * always win, so a caller that resolved its own key keeps working.
 */
export async function resolveJobPayload(
  userId: string,
  type: string,
  args: Record<string, unknown>,
): Promise<ResolvedJobPayload> {
  // Per-task override first, so a job runs on the model the user configured for
  // that step rather than silently falling back to the SEO-wide one.
  const creds = await resolveAiCreds(userId, args, taskForJobType(type));
  if (!creds.aiApiKey) throw new Error("No AI key is configured on this instance (SEO Tools → Settings).");

  const serpCreds = SERP_TYPES.has(type) ? await resolveSerpCreds(userId, args) : null;

  const policy = (args.payload as { policy?: unknown } | undefined)?.policy ?? (await resolveActivePolicy(userId, args));

  const knobs: Record<string, unknown> = {};
  for (const k of JOB_KNOBS) {
    if (args[k] !== undefined && args[k] !== null) knobs[k] = args[k];
  }
  const payload: Record<string, unknown> = {
    ...knobs,
    ...((args.payload as object) ?? {}),
    ...creds,
    ...(serpCreds ?? {}),
    ...(policy ? { policy } : {}),
  };

  // The QA judge (outline/text/landing results) runs on its own per-task slot —
  // the same "judge" resolution the tool pages use, so every path judges with
  // the same model. Fields are ignored by the pipelines that don't judge.
  try {
    const jc = await resolveAiCreds(userId, {}, "judge");
    payload.judgeProvider = jc.aiProvider;
    payload.judgeApiKey = jc.aiApiKey;
    if (jc.model) payload.judgeModel = jc.model;
    if (jc.aiBaseUrl) payload.judgeBaseUrl = jc.aiBaseUrl;
  } catch { /* judging falls back to the writer's provider */ }

  // Standby providers: the least supervised paths (agent, batch queue) need to
  // finish on a different provider when the configured one starts discarding
  // finished generations. An explicit aiFallbacks in the payload still wins.
  if (!payload.aiFallbacks) {
    try {
      const alts = await resolveAiFallbacks(userId, creds.aiProvider);
      if (alts.length) payload.aiFallbacks = alts;
    } catch { /* a missing safety net must not block the job */ }
  }

  return { payload };
}

// ─── outline resolution for text jobs ────────────────────────────────────────
// outlineId → outline, shared by the MCP tool and the batch queue's text phase.
// Two stores, in the order a caller will reach for them: SeoHistory (what
// get_generations lists — the same records the browser's structure picker
// syncs from), then a completed outline/outline_auto SeoJob — so the jobId of
// a just-finished outline job works as the outlineId of the follow-up text
// job with zero extra calls.
const jobsTable = () => dbAny.seoJob;

export async function fetchSavedOutline(userId: string, outlineId: string): Promise<{ outline: unknown; keyword: string } | null> {
  const id = outlineId.trim();
  if (!id) return null;
  try {
    const rows = await rawQuery<{ keyword: string | null; data: string | null }[]>(
      `SELECT keyword, data FROM "SeoHistory" WHERE id = ? AND userId = ?`, id, userId);
    if (rows.length) {
      const outline = coerceOutline(parseJson(rows[0].data));
      if (outline) return { outline, keyword: String(rows[0].keyword ?? "") };
    }
  } catch { /* table not migrated → try the job row */ }
  try {
    const job = await jobsTable().findFirst({
      where: { id, userId, status: "completed", type: { in: ["outline", "outline_auto"] } },
    });
    if (job) {
      const outline = coerceOutline(parseJson(job.result));
      if (outline) return { outline, keyword: String(job.keyword ?? "") };
    }
  } catch { /* not migrated either → caller reports the miss */ }
  return null;
}
