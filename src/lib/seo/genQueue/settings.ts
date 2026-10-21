// Generation batch queue settings — same convention as the audit queue
// (lib/audit/queue.ts): one JSON column per owner (User.genQueueSettings),
// defaults in code, the column written only when an operator changes
// something.
//
// The two concurrency knobs mean different things and both are labelled
// honestly in the UI:
//   concurrency         — how many batch ITEMS (pages) may be mid-generation
//   providerConcurrency — how many LLM REQUESTS may hit one key at once,
//                         process-wide (enforced by the per-key semaphore in
//                         lib/llm.ts), because one job already fans out to ~2
//                         parallel calls (runPool in generate.ts) and UI/MCP
//                         jobs bypass the queue entirely.

import { prisma } from "@/lib/prisma";
import { setLLMKeyConcurrency } from "@/lib/llm";

export interface GenQueueSettings {
  /** Batch items (pages) in flight per workspace. Slider 1–16. */
  concurrency: number;
  /** Max simultaneous LLM calls per provider key across the WHOLE process.
   *  0 disables the gate. Applied via setLLMKeyConcurrency. */
  providerConcurrency: number;
  /** Extra attempts per item after the first (retry policy). */
  retryAttempts: number;
  /** Minutes before a retried item becomes due again. */
  retryDelayMin: number;
  /** Global pause switch — no batch item starts while on. */
  paused: boolean;
}

export const DEFAULT_GEN_QUEUE_SETTINGS: GenQueueSettings = {
  concurrency: 2,
  providerConcurrency: 8,
  retryAttempts: 1,
  retryDelayMin: 10,
  paused: false,
};

function num(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function parseGenQueueSettings(json: string | null | undefined): GenQueueSettings {
  let parsed: Record<string, unknown> = {};
  try { parsed = json ? (JSON.parse(json) as Record<string, unknown>) : {}; } catch { /* fresh column */ }
  return {
    concurrency: num(parsed?.concurrency, DEFAULT_GEN_QUEUE_SETTINGS.concurrency, 1, 16),
    providerConcurrency: num(parsed?.providerConcurrency, DEFAULT_GEN_QUEUE_SETTINGS.providerConcurrency, 0, 32),
    retryAttempts: num(parsed?.retryAttempts, DEFAULT_GEN_QUEUE_SETTINGS.retryAttempts, 0, 5),
    retryDelayMin: num(parsed?.retryDelayMin, DEFAULT_GEN_QUEUE_SETTINGS.retryDelayMin, 1, 1440),
    paused: parsed?.paused === true,
  };
}

export async function getGenQueueSettings(userId: string): Promise<GenQueueSettings> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { genQueueSettings: true } }).catch(() => null);
  return parseGenQueueSettings(user?.genQueueSettings);
}

export async function saveGenQueueSettings(userId: string, s: GenQueueSettings): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { genQueueSettings: JSON.stringify(s) } });
}

/**
 * Push the strictest configured provider-call limit into the llm.ts semaphore.
 * The gate is process-wide (a provider key does not care which workspace sent
 * the request), so when several operators configured a limit the SMALLEST wins
 * — nobody's provider budget is silently exceeded. No limit configured
 * anywhere → the code default (8).
 */
export async function syncLLMKeyConcurrency(): Promise<number> {
  let limit = 0;
  try {
    const rows = await prisma.user.findMany({
      where: { genQueueSettings: { not: null } },
      select: { genQueueSettings: true },
    });
    for (const row of rows) {
      const s = parseGenQueueSettings(row.genQueueSettings);
      if (s.providerConcurrency > 0 && (limit === 0 || s.providerConcurrency < limit)) limit = s.providerConcurrency;
    }
  } catch { /* column not migrated → keep the default */ }
  const effective = limit > 0 ? limit : DEFAULT_GEN_QUEUE_SETTINGS.providerConcurrency;
  setLLMKeyConcurrency(effective);
  return effective;
}
