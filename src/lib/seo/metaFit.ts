// T1 (docs/tasks/wave-oct/T1-meta-fit.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { MetaField, MetaFitItem, MetaFitResponse, MetaFitResult } from "./metaLimits";

/** Pure. Best existing candidate or a deterministic trim; never calls a model. */
export function fitMetaLocal(field: MetaField, value: string, options: string[], keyword: string, brand?: string): MetaFitResult {
  throw new Error("wave: fitMetaLocal not implemented (T1)");
}

/** Parse the ```Title: …``` block at the head of an article. Null when absent. */
export function readMetaBlock(text: string): { title: string; description: string; slug: string } | null {
  throw new Error("wave: readMetaBlock not implemented (T1)");
}

/** Replace the values inside an existing block; returns text unchanged when no block. */
export function writeMetaBlock(text: string, meta: { title?: string; description?: string }): string {
  throw new Error("wave: writeMetaBlock not implemented (T1)");
}

/** Local first, then up to 2 repair calls when allowLlm. */
export async function fitMeta(item: MetaFitItem, llm: { allow: boolean; provider?: string; apiKey?: string; model?: string; baseUrl?: string }): Promise<MetaFitResponse> {
  throw new Error("wave: fitMeta not implemented (T1)");
}
