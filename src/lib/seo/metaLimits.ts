// One source of truth for meta-tag lengths. The audit (src/lib/audit/rules.ts) flags OUTSIDE
// the audit band; the generators (src/lib/seo/metaFit.ts) aim INSIDE the target band, which
// sits wholly inside the audit band so a freshly generated page is never flagged.
// Lengths are counted in Unicode code points (Array.from(s).length), after trimming.

export const META_LIMITS = {
  title:       { targetMin: 50,  targetMax: 60,  auditMin: 50,  auditMax: 65 },
  description: { targetMin: 150, targetMax: 160, auditMin: 150, auditMax: 165 },
} as const;

export type MetaField = keyof typeof META_LIMITS;

export const metaLength = (s: string): number => Array.from(s.trim()).length;

export type MetaFitMethod =
  | "kept"          // the value was already inside the target band
  | "picked"        // another existing option was inside the band and was chosen
  | "trimmed"       // deterministic removal of a trailing clause
  | "llm"           // a repair call produced an in-band variant
  | "forced_cut"    // word-boundary cut; last resort, reported as a concern
  | "unfixable";    // nothing worked (e.g. too short and no LLM allowed); left as is

export interface MetaFitResult {
  field: MetaField;
  before: string;
  after: string;
  length: number;
  method: MetaFitMethod;
  inBand: boolean;      // targetMin ≤ length ≤ targetMax
  auditOk: boolean;     // auditMin ≤ length ≤ auditMax
}

export interface MetaFitItem {
  id?: string;          // caller's id (history id, audit page url…) — echoed back
  keyword: string;      // main query; kept at the start of the title when possible
  language: string;     // ISO-639-1
  title?: string;
  description?: string;
  titleOptions?: string[];
  descriptionOptions?: string[];
  brand?: string;       // if present, may be dropped first when over the limit
}

export interface MetaFitResponse {
  id?: string;
  title?: MetaFitResult;
  description?: MetaFitResult;
  llmCalls: number;     // 0 when everything was solved deterministically
}
