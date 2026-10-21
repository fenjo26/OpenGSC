import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  createGenBatch, listGenBatches, kickGenQueue,
  getGenQueueSettings, saveGenQueueSettings,
} from "@/lib/seo/genQueue/queue";
import { syncLLMKeyConcurrency } from "@/lib/seo/genQueue/settings";
import type { BatchItemInput } from "@/lib/seo/genQueue/plan";

// POST /api/seo/batch — create a batch of page orders (outline, optionally
// outline+text). Thousands of items in one call: the queue drains them under
// the workspace's concurrency setting, so the provider never sees them all at
// once. Body: { name, pipeline: "outline"|"outline_text", keywords?: string[],
// items?: [{ keyword, siteId?, priority?, payload? }], defaults?, clientBatchId?, pauseAfterErrors? }.
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  const pipeline = b.pipeline === "outline" ? "outline" : "outline_text";
  // Two item spellings: a plain keyword list (shared defaults for everything)
  // or per-item objects with overrides. Both may arrive; both are normalized.
  const items: BatchItemInput[] = Array.isArray(b.items)
    ? (b.items as BatchItemInput[]).filter(x => x && typeof x.keyword === "string")
    : Array.isArray(b.keywords)
      ? (b.keywords as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0).map(keyword => ({ keyword }))
      : [];
  if (!items.length) return NextResponse.json({ error: "no_items" }, { status: 400 });

  try {
    const r = await createGenBatch(userId, {
      name: String(b.name ?? ""),
      pipeline,
      items,
      defaults: (b.defaults && typeof b.defaults === "object") ? b.defaults as Record<string, unknown> : undefined,
      pauseAfterErrors: b.pauseAfterErrors == null ? undefined : Number(b.pauseAfterErrors),
      clientBatchId: b.clientBatchId == null ? undefined : String(b.clientBatchId),
    });
    kickGenQueue();
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
}

// GET /api/seo/batch — the batch list with live counters + the queue settings
// (the Batch page renders both in one fetch, the audits-page convention).
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [batches, settings] = await Promise.all([listGenBatches(userId), getGenQueueSettings(userId)]);
    return NextResponse.json({ batches, settings });
  } catch {
    return NextResponse.json({ batches: [], settings: null, error: "not_migrated" }); // before db push
  }
}

// PATCH /api/seo/batch — queue settings: concurrency (items in flight),
// providerConcurrency (LLM calls per key, process-wide), retry knobs, pause.
export async function PATCH(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  try {
    const current = await getGenQueueSettings(userId);
    const next = {
      concurrency: b.concurrency == null ? current.concurrency : Number(b.concurrency),
      providerConcurrency: b.providerConcurrency == null ? current.providerConcurrency : Number(b.providerConcurrency),
      retryAttempts: b.retryAttempts == null ? current.retryAttempts : Number(b.retryAttempts),
      retryDelayMin: b.retryDelayMin == null ? current.retryDelayMin : Number(b.retryDelayMin),
      paused: b.paused == null ? current.paused : b.paused === true,
    };
    await saveGenQueueSettings(userId, next);
    // The provider gate is process-wide — apply the new limit immediately,
    // not at the next scheduler tick.
    await syncLLMKeyConcurrency();
    if (!next.paused) kickGenQueue();
    return NextResponse.json({ settings: next });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
}
