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
): Promise<void> {
  const htype = HISTORY_TYPE[String(job.type)];
  if (!htype || result == null) return;
  const isText = String(job.type) === "text";
  const data = isText ? ((result as any)?.text ?? result) : result;
  const diag = isText ? textDiagnostics(result) : null;
  try {
    await runUpsert({
      table: "SeoHistory",
      conflict: ["id"],
      values: {
        id: job.id, userId, type: htype, keyword: job.keyword || "—",
        status: "completed", data: JSON.stringify(data),
        meta: JSON.stringify({ jobId: job.id, ...(diag ? { diagnostics: diag } : {}) }),
        createdAt: new Date(job.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      // id never drifts, and createdAt keeps the original moment. The browser adopts this row
      // through its history sync (missing ids merge in), so its later pushes refresh the copy.
      update: { data: "set", meta: "set", status: "set", keyword: "set", updatedAt: "set" },
    });
  } catch { /* SeoHistory not migrated — the SeoJob row still carries the result */ }
}
