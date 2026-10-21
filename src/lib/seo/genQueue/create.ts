// Batch creation writes — the durable half of plan.ts. One call may order
// thousands of pages; item rows go in with createMany chunks so a single
// insert never has to carry the whole order.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { planBatch, estimateBatchCalls, type BatchItemInput, type PlanBatchInput } from "./plan";

const CHUNK = 500;

export interface CreateBatchResult {
  batchId: string;
  name: string;
  pipeline: string;
  /** Items created (outline + text phases counted separately). */
  outlineItems: number;
  textItems: number;
  /** Exact in-batch duplicates dropped at plan time (keyword + market). */
  skippedDuplicates: string[];
  /** Keywords that already have a generated outline/text in SeoHistory —
   *  created anyway (a different site or a refresh may be intended), but
   *  reported so the agent/operator can decide instead of double-paying
   *  silently. */
  alreadyGenerated: string[];
  /** Rough provider-call estimate for the confirm surface. */
  estimatedCalls: number;
  /** True when a clientBatchId matched an existing batch and NOTHING was
   *  created — an agent retrying after a timeout must not double-order. */
  existing: boolean;
}

export async function createGenBatch(
  userId: string,
  input: PlanBatchInput & { clientBatchId?: string },
): Promise<CreateBatchResult> {
  // Idempotency first: the same clientBatchId returns the existing order.
  if (input.clientBatchId) {
    const existing = await prisma.seoBatch.findFirst({
      where: { userId, clientBatchId: String(input.clientBatchId).slice(0, 200) },
      select: {
        id: true, name: true, pipeline: true,
        _count: { select: { items: { where: { phase: "outline" } } } },
      },
    }).catch(() => null);
    if (existing) {
      const textCount = await prisma.seoBatchItem.count({ where: { batchId: existing.id, phase: "text" } }).catch(() => 0);
      return {
        batchId: existing.id, name: existing.name, pipeline: existing.pipeline,
        outlineItems: existing._count.items, textItems: textCount,
        skippedDuplicates: [], alreadyGenerated: [],
        estimatedCalls: estimateBatchCalls(existing.pipeline === "outline" ? "outline" : "outline_text", existing._count.items),
        existing: true,
      };
    }
  }

  const plan = planBatch(input, () => randomUUID());
  if (!plan.items.length) throw new Error("No usable keywords in the batch — every item was empty or a duplicate.");

  // Cross-check against what was already generated: an outline/text for the
  // exact keyword exists in History. Reported, not skipped — the operator may
  // legitimately want a second site's version.
  const alreadyGenerated: string[] = [];
  try {
    const keywords = [...new Set(plan.items.map(i => i.keyword))];
    for (let i = 0; i < keywords.length; i += CHUNK) {
      const slice = keywords.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const rows = await rawQuery<{ keyword: string }[]>(
        `SELECT DISTINCT keyword FROM "SeoHistory" WHERE userId = ? AND keyword IN (${placeholders}) LIMIT ${CHUNK}`,
        userId, ...slice);
      for (const r of rows) alreadyGenerated.push(String(r.keyword));
    }
  } catch { /* table not migrated → skip the cross-check */ }

  const batch = await prisma.seoBatch.create({
    data: {
      userId,
      name: plan.name,
      pipeline: plan.pipeline,
      status: "active",
      itemDefaults: input.defaults && Object.keys(input.defaults).length ? JSON.stringify(input.defaults) : null,
      pauseAfterErrors: plan.pauseAfterErrors,
      ...(input.clientBatchId ? { clientBatchId: String(input.clientBatchId).slice(0, 200) } : {}),
    },
  });

  for (let i = 0; i < plan.items.length; i += CHUNK) {
    const slice = plan.items.slice(i, i + CHUNK).map(item => ({
      id: item.id,
      batchId: batch.id,
      userId,
      ...(item.siteId ? { siteId: item.siteId } : {}),
      phase: item.phase,
      keyword: item.keyword,
      payload: item.payload,
      priority: item.priority,
      ...(item.dependsOnItemId ? { dependsOnItemId: item.dependsOnItemId } : {}),
    }));
    await prisma.seoBatchItem.createMany({ data: slice });
  }

  const outlineItems = plan.items.filter(i => i.phase === "outline").length;
  const textItems = plan.items.length - outlineItems;
  return {
    batchId: batch.id,
    name: plan.name,
    pipeline: plan.pipeline,
    outlineItems,
    textItems,
    skippedDuplicates: plan.skippedDuplicates,
    alreadyGenerated,
    estimatedCalls: estimateBatchCalls(plan.pipeline, outlineItems),
    existing: false,
  };
}
