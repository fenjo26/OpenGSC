import { runUpsert } from "@/lib/db/upsert";
import { HISTORY_TYPE, textDiagnostics } from "@/lib/seo/historyShared";

// Completed SeoJob → the shared SeoHistory store. SeoHistory is the source of truth for the
// SEO Tools History: writing the result here the moment a job completes means the record
// exists server-side even if no browser tab ever imports the job row. The row id IS the job
// id, so the browser's own import of the same job converges on this row instead of forking
// a second one under a fresh id.
export async function saveJobToHistory(
  userId: string,
  job: { id: string; type: string; keyword?: string; createdAt?: Date | string },
  result: unknown,
  /** Provenance worth keeping on the record: batchId/batchItemId for batch items,
   *  language/country of the market. Without it History cannot say which batch or
   *  market a page belongs to, and an agent filtering by them finds nothing. */
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  const htype = HISTORY_TYPE[String(job.type)];
  if (!htype || result == null) return;
  const isText = String(job.type) === "text";
  const data = isText ? ((result as { text?: unknown } | null | undefined)?.text ?? result) : result;
  const diag = isText ? textDiagnostics(result) : null;
  try {
    await runUpsert({
      table: "SeoHistory",
      conflict: ["id"],
      values: {
        id: job.id, userId, type: htype, keyword: job.keyword || "—",
        status: "completed", data: JSON.stringify(data),
        meta: JSON.stringify({ ...cleanMeta(extraMeta), jobId: job.id, ...(diag ? { diagnostics: diag } : {}) }),
        createdAt: new Date(job.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      // id never drifts, and createdAt keeps the original moment. The browser adopts this row
      // through its history sync (missing ids merge in), so its later pushes refresh the copy.
      update: { data: "set", meta: "set", status: "set", keyword: "set", updatedAt: "set" },
    });
  } catch { /* SeoHistory not migrated — the SeoJob row still carries the result */ }
}

// Only short scalar provenance fields — never a payload dump (it would carry keys).
const META_KEYS = ["batchId", "batchItemId", "language", "country", "siteId", "tone", "promptType"] as const;
function cleanMeta(m: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const k of META_KEYS) {
    const v = m[k];
    if (v == null || v === "" || typeof v === "object") continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

/** Provenance for saveJobToHistory from a job row's meta JSON plus the payload knobs. */
export function historyMetaFrom(jobMeta: string | null | undefined, payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  let m: Record<string, unknown> = {};
  try { m = jobMeta ? (JSON.parse(jobMeta) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
  const p = payload ?? {};
  return { ...m, language: m.language ?? p.language, country: m.country ?? p.country, tone: m.tone ?? p.tone, promptType: m.promptType ?? p.promptType };
}
