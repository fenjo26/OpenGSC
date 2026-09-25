export interface IndexInspectSettings {
  on: boolean;
  dailyBudget: number;          // auto share of the 2000/day property quota; clamp 0..1800
  recheckIndexedDays: number;   // default 14
  recheckNotIndexedDays: number;// default 3
  alertOnLoss: boolean;         // indexed → not indexed for a page with clicks in the last 28 days
}

export const DEFAULT_INDEX_INSPECT: IndexInspectSettings = {
  on: false, dailyBudget: 1000, recheckIndexedDays: 14, recheckNotIndexedDays: 3, alertOnLoss: true,
};

export const INSPECTION_DAILY_LIMIT = 2000;   // Google, per property
export const INSPECTION_PER_MINUTE = 60;      // ours; Google allows 600 — we stay 10× below
export const INSPECTION_TZ = "America/Los_Angeles";

export type InspectPriority = "new" | "changed" | "not_indexed" | "stale_indexed";

export interface InspectCandidate {
  url: string;
  priority: InspectPriority;
  firstSeenAt: string;          // ISO
  googleChecked: string | null; // ISO
}

export interface InspectOutcome {
  url: string;
  ok: boolean;                  // the API answered
  verdict: string | null;
  coverageState: string | null;
  indexed: boolean | null;      // null when !ok
  lastCrawl: string | null;
  googleCanonical: string | null;
  error: string | null;
  quotaExhausted: boolean;
}

export interface IndexAutoStatus {
  settings: IndexInspectSettings;
  property: string;
  quota: { day: string; used: number; auto: number; limit: number; exhausted: boolean };
  queue: Record<InspectPriority, number>;
  coverage: { day: string; total: number; indexed: number; notIndexed: number; unknown: number }[]; // last 90 days
  reasons: { coverageState: string; count: number }[];   // current not-indexed breakdown
  recentLosses: { url: string; lostAt: string; coverageState: string | null; clicks28d: number }[];
}
