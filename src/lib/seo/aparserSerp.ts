// SERP Monitor — pure SE::Google mapping, no transport. Stub: T1 owns the implementation
// (see docs/tasks/serp-monitor/). Never parses `resultString`, only `results[0]` (`rawResults: 1`).
import type { AparserOption } from "./aparser";
import type { SerpResultItem } from "./serp";

export const APARSER_SERP_PARSERS: Record<"google", string> = { google: "SE::Google" };

export interface AparserSerpOptionIds {
  pagecount: string;      // pages to fetch
  country?: string;       // search country (gl)
  language?: string;      // results / interface language (hl)
}

/** Verified against a live SE::Google preset by scripts/aparser-serp-probe.ts — see T1. */
export const APARSER_SERP_OPTION_IDS: AparserSerpOptionIds = { pagecount: "pagecount" };

export function aparserSerpOptions(o: { depth: number; gl: string; hl: string }, ids?: AparserSerpOptionIds): AparserOption[] {
  throw new Error("serpmon: aparserSerpOptions not implemented (T1)");
}

export function mapAparserSerp(row: unknown, want: number): {
  results: SerpResultItem[];   // position = 1-based order after dedupe by exact url, cut to `want`
  totalCount: string;          // "" when absent
  features: string[];
  problem: string | null;      // parserResultProblem(row, ["serp"])
} {
  throw new Error("serpmon: mapAparserSerp not implemented (T1)");
}
