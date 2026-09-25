// T6 (docs/tasks/wave-oct/T6-mentions.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { MentionHit, MentionTerm } from "./types";

export function parseGoogleNewsRss(xml: string, term: string, lang: string): MentionHit[] {
  throw new Error("wave: parseGoogleNewsRss not implemented (T6)");
}

export function matchesTerm(text: string, t: MentionTerm): boolean {
  throw new Error("wave: matchesTerm not implemented (T6)");
}

export function isExcluded(hit: MentionHit, exclude: string[]): boolean {
  throw new Error("wave: isExcluded not implemented (T6)");
}

export function normalizeMentionUrl(url: string): string {
  throw new Error("wave: normalizeMentionUrl not implemented (T6)");
}

export function deriveTerms(brandedKeywords: string | null, host: string): MentionTerm[] {
  throw new Error("wave: deriveTerms not implemented (T6)");
}
