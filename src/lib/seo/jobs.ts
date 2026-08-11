"use client";

// Client helpers for server-side background generation jobs.
// A job runs on the server and persists its result, so the user can close the tab and
// pick the finished task up later from History. Completed jobs are imported into the
// local (localStorage) History so the existing detail/render pages work unchanged.

import { addHistory, loadHistory, HistoryItem, HistoryType } from "@/lib/seo/history";

export interface SeoJobRec {
  id: string;
  type: HistoryType;
  keyword: string;
  status: "processing" | "completed" | "error";
  stage?: string;
  progress?: number;
  attempt?: number;
  heartbeatAt?: string | null;
  checkpoint?: string | null;
  resumable?: boolean;
  result?: string | null;
  error?: string | null;
  meta?: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function startJob(type: HistoryType | "outline_auto", payload: any, meta?: any): Promise<{ jobId?: string; error?: string }> {
  try {
    const keyword = payload?.keyword || payload?.outline?.meta?.keyword || "";
    const res = await fetch("/api/seo/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, keyword, payload, meta }),
    });
    const d = await res.json();
    if (!res.ok) return { error: d.error || "job_failed" };
    return { jobId: d.jobId };
  } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

export async function getJob(id: string): Promise<SeoJobRec | null> {
  try {
    const res = await fetch(`/api/seo/jobs/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()).job ?? null;
  } catch { return null; }
}

export async function listJobs(): Promise<SeoJobRec[]> {
  try {
    const res = await fetch("/api/seo/jobs", { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()).jobs ?? [];
  } catch { return []; }
}

export async function deleteJob(id: string): Promise<void> {
  try { await fetch(`/api/seo/jobs/${id}`, { method: "DELETE" }); } catch {}
}

// Bulk-remove failed jobs (server-side). Returns how many were deleted.
export async function clearFailedJobs(): Promise<number> {
  try {
    const res = await fetch("/api/seo/jobs?failed=1", { method: "DELETE" });
    if (!res.ok) return 0;
    return (await res.json()).deleted ?? 0;
  } catch { return 0; }
}

function safeParse(s?: string | null): any { if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } }

// Job types this browser History owns, and may therefore consume and delete server-side.
//
// The History page imports every completed job it finds, so anything NOT listed here is
// left alone deliberately. `rewrite` batches are started over MCP by an agent that polls
// the server row for its results — if an open OpenGSC tab imported one, it would file it
// under a type History cannot render AND delete the server copy, so the agent's next poll
// would report the job missing and pages the user had already paid for would be gone.
// A job whose owner is not this browser is not this browser's to collect.
const IMPORTABLE_TYPES = new Set(["outline", "outline_auto", "text", "analysis", "landing", "cluster"]);

// Map a completed job's result into a local History item, then drop the server copy.
// Always removes the server job afterwards (even if unparseable) to avoid re-import loops.
// Dedupe: a job is imported at most once — guarded against concurrent callers in this tab
// (onDone + History page both firing) via an in-flight set, and against repeats via the
// jobId stamped into the history record's meta.
const importing = new Set<string>();
export async function importJob(job: SeoJobRec): Promise<HistoryItem | null> {
  if (job.status !== "completed") return null;
  if (!IMPORTABLE_TYPES.has(String(job.type))) return null;
  if (importing.has(job.id)) return null;
  importing.add(job.id);
  try {
    const existing = loadHistory().find(h => h.meta?.jobId === job.id);
    if (existing) { await deleteJob(job.id); return existing; }
    const result = safeParse(job.result);
    let rec: HistoryItem | null = null;
    if (result != null) {
      const data = job.type === "text" ? (result.text ?? result) : result;
      const createdAt = Date.parse(job.createdAt || "") || undefined;
      // outline_auto (batch SERP→scrape→outline) lands in history as a regular outline.
      const htype = (String(job.type) === "outline_auto" ? "outline" : job.type) as HistoryItem["type"];
      rec = addHistory({
        type: htype, keyword: job.keyword || "—", data, createdAt,
        meta: { ...(safeParse(job.meta) || {}), jobId: job.id },
      });
    }
    await deleteJob(job.id);
    return rec;
  } finally {
    importing.delete(job.id);
  }
}
