// T7 (docs/tasks/wave-oct/T7-ai-share-of-voice.md) owns this file and replaces the throwing
// bodies. The signatures below are the wave contract (CONTRACT.md §3) — every caller in the
// wave compiles against them from the first commit.

import type { AiCompetitor, CitedDomainRow, SovReport } from "./types";

export interface SovAnswer { questionId: string; question: string; engine: string; checkedAt: Date; answerText: string | null; citations: { url: string; domain: string; title: string }[]; rank: number | null; status: string | null }

export function mentionsOf(text: string, terms: string[]): boolean {
  throw new Error("wave: mentionsOf not implemented (T7)");
}

export function latestPerQuestionEngine(answers: SovAnswer[], from: Date, to: Date): SovAnswer[] {
  throw new Error("wave: latestPerQuestionEngine not implemented (T7)");
}

export function buildSovReport(answers: SovAnswer[], us: { host: string; terms: string[] }, rivals: AiCompetitor[], from: Date, to: Date): SovReport {
  throw new Error("wave: buildSovReport not implemented (T7)");
}

export function buildCitedDomains(answers: SovAnswer[], us: { host: string }, rivals: AiCompetitor[], limit: number): CitedDomainRow[] {
  throw new Error("wave: buildCitedDomains not implemented (T7)");
}

export function questionLike(query: string, lang: string): boolean {
  throw new Error("wave: questionLike not implemented (T7)");
}
