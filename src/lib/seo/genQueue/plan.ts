// Pure planning helpers for batch creation — no database, unit-testable.
// create.ts owns the writes; everything that can be decided mechanically
// (normalization, in-batch dedupe, credential stripping, the cost estimate)
// lives here so the policy is identical for the UI and the MCP tool.

export interface BatchItemInput {
  keyword: string;
  siteId?: string;
  priority?: number;
  /** Per-item knob overrides (language, country, tone, …). Knobs only —
   *  credential-looking keys are stripped before anything is persisted. */
  payload?: Record<string, unknown>;
}

export interface PlanBatchInput {
  name: string;
  pipeline: "outline" | "outline_text";
  /** Shared knobs applied to every item unless the item overrides them. */
  defaults?: Record<string, unknown>;
  items: BatchItemInput[];
  pauseAfterErrors?: number;
}

export interface PlannedItem {
  id: string;
  phase: "outline" | "text";
  keyword: string;
  siteId?: string;
  priority: number;
  payload: string | null;
  dependsOnItemId?: string;
}

export interface BatchPlan {
  name: string;
  pipeline: "outline" | "outline_text";
  itemDefaults: string | null;
  pauseAfterErrors: number;
  items: PlannedItem[];
  skippedDuplicates: string[];
}

// Rough midpoints of AI calls per phase, from the pipeline's own shape (SERP
// MAP per competitor, fact batches, outline+enrich, chunked writing + FAQ +
// judge + repair passes). An ESTIMATE for the confirm screen, never a bill.
export const ESTIMATED_CALLS = { outline: 7, text: 8 } as const;
export function estimateBatchCalls(pipeline: "outline" | "outline_text", pages: number): number {
  const perPage = ESTIMATED_CALLS.outline + (pipeline === "outline_text" ? ESTIMATED_CALLS.text : 0);
  return perPage * pages;
}

// Key names that must never ride into a stored item payload. The batch API
// accepts knobs only, but stripping here is defense in depth: a caller that
// forwards a browser-shaped payload (with resolved keys inside) must not be
// able to persist thousands of API-key copies into the database.
const SECRET_KEY_RE = /api_?key|secret|password|token|serp_?key|base_?url.*key|fallbacks?/i;
export function stripSecrets(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function normalizeKeyword(k: unknown): string {
  return String(k ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
}

function payloadKey(p: Record<string, unknown>): string {
  // Country + language define the market: the same keyword in the same market
  // is one page — regardless of which site item carries it, because two sites
  // of one network answering the same query in the same GEO cannibalize each
  // other. Anything else (tone, length…) may legitimately differ per item.
  const country = String(p.country ?? "").trim().toLowerCase();
  const language = String(p.language ?? "").trim().toLowerCase();
  return `${country}|${language}`;
}

/**
 * Turn raw input into the item rows to insert. Exact duplicates (same
 * normalized keyword + same market) are dropped after the first occurrence
 * and reported — the caller decides whether to surface them as warnings; we
 * never silently double-order the same page.
 */
export function planBatch(input: PlanBatchInput, newId: () => string): BatchPlan {
  const defaults = stripSecrets(input.defaults);
  const pipeline = input.pipeline === "outline" ? "outline" : "outline_text";
  const items: PlannedItem[] = [];
  const skippedDuplicates: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.items ?? []) {
    const keyword = normalizeKeyword(raw?.keyword);
    if (!keyword) continue;
    const overrides = stripSecrets(raw?.payload);
    const merged = { ...defaults, ...overrides };
    const key = `${keyword.toLowerCase()}|${payloadKey(merged)}`;
    if (seen.has(key)) { skippedDuplicates.push(keyword); continue; }
    seen.add(key);

    const outlineId = newId();
    items.push({
      id: outlineId,
      phase: "outline",
      keyword,
      siteId: raw?.siteId ? String(raw.siteId) : undefined,
      priority: Number.isFinite(Number(raw?.priority)) ? Math.max(-100, Math.min(100, Math.round(Number(raw.priority)))) : 0,
      payload: Object.keys(merged).length ? JSON.stringify(merged) : null,
    });
    if (pipeline === "outline_text") {
      items.push({
        id: newId(),
        phase: "text",
        keyword,
        siteId: raw?.siteId ? String(raw.siteId) : undefined,
        priority: Math.max(-100, Math.min(100, Math.round(Number(raw?.priority ?? 0)))),
        // The text phase inherits the merged knobs; the outline itself is
        // injected at run time from the completed outline item's jobId.
        payload: Object.keys(merged).length ? JSON.stringify(merged) : null,
        dependsOnItemId: outlineId,
      });
    }
  }

  return {
    name: String(input.name ?? "").trim().slice(0, 120) || "Batch",
    pipeline,
    itemDefaults: null, // defaults are already merged into each item — one source per item
    pauseAfterErrors: Number.isFinite(Number(input?.pauseAfterErrors))
      ? Math.max(0, Math.min(100, Math.round(Number(input.pauseAfterErrors))))
      : 5,
    items,
    skippedDuplicates,
  };
}
