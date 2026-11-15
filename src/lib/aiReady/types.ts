// AI Readiness — the shapes shared by the three parts, the score and the store.
//
// The module answers one question the GEO Audit and the AEO Tracker can only observe from the
// outside: how reachable and how visible is this site for AI engines. Three independent parts,
// each free and each optional:
//   access   (T1) — robots.txt + /llms.txt + a User-Agent parity probe of the homepage;
//   presence (T2) — in how many of the last monthly Common Crawl archives the domain appears;
//   rank     (T3) — the domain's position in Common Crawl's web graph (harmonic centrality).
//
// A part that could not be read is absent or carries nulls. It is never turned into a zero: a
// failed lookup must not lower the grade (docs/tasks/ai-readiness/CONTRACT.md §0.3).

import type { AiCrawlReport } from "@/lib/audit/aiCrawl";

export type AiReadyPartName = "access" | "presence" | "rank";

// ─── T1 ───────────────────────────────────────────────────────────────────────

export type ParityVerdict =
  | "same"          // served what the browser got
  | "different"     // 2xx, same host, but the text diverges beyond the page's own noise
  | "redirected"    // ended on another host than the browser did
  | "blocked"       // non-2xx while the browser got 2xx
  | "challenge"     // a captcha / JS-check interstitial
  | "error"         // network failure or timeout — says nothing about the site's policy
  | "inconclusive"; // the browser baseline itself failed, so there is nothing to compare to

export interface ParityRow {
  id: string;        // "gptbot"
  label: string;     // "GPTBot"
  engine: string;    // "ChatGPT / OpenAI"
  status: number | null;
  verdict: ParityVerdict;
  /** Best text similarity against the two browser fetches, 0..1. Null when not comparable. */
  similarity: number | null;
}

export interface ParityReport {
  url: string;
  baselineStatus: number | null;
  /** 1 − similarity of the two browser fetches: how much the page differs from itself. */
  noiseFloor: number | null;
  conclusive: boolean;
  rows: ParityRow[];
}

export interface AccessPart {
  crawl: AiCrawlReport;
  parity: ParityReport;
  checkedAt: string;
}

// ─── T2 ───────────────────────────────────────────────────────────────────────

export interface PresenceMonth {
  crawl: string;            // "CC-MAIN-2026-43"
  month: string;            // "2026-10"
  /** null = could not be read; stays queued for the next run. */
  present: boolean | null;
  captures: number;
  /** true when the count stopped at the block limit — "at least this many". */
  capped: boolean;
}

export interface PresencePart {
  months: PresenceMonth[];  // newest first
  /** Months still unread (never tried or failed). The UI re-calls while this is > 0. */
  pending: number;
  checkedAt: string;
}

// ─── T3 ───────────────────────────────────────────────────────────────────────

export type RankStatus =
  | "ok"
  | "not_found"       // the directory answered: this domain is not in the graph
  | "unavailable"     // the directory could not be reached or answered garbage
  | "not_configured"; // OPENGSC_CCRANK_URL=off

export interface RankPart {
  status: RankStatus;
  release: string | null;
  /** The domain the directory matched (the registrable domain when a subdomain was asked). */
  domain: string | null;
  hcRank: number | null;
  prRank: number | null;
  total: number | null;
  hosts: number | null;
  /** 0–100, log-scaled position. Null unless status is ok / not_found. */
  authority: number | null;
  checkedAt: string;
}

// ─── Score ────────────────────────────────────────────────────────────────────

export type AiReadyGrade = "A" | "B" | "C" | "D" | "E" | "F";

export interface AiReadyScore {
  score: number | null;
  grade: AiReadyGrade | null;
  parts: { access: number | null; presence: number | null; authority: number | null };
  /** Which parts the score was built from — a score without this list is not comparable. */
  coverage: AiReadyPartName[];
}

export interface AiReadyReport {
  domain: string;
  access?: AccessPart;
  presence?: PresencePart;
  rank?: RankPart;
  score: AiReadyScore;
  updatedAt: string;
}
