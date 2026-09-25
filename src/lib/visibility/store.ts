// T7 (docs/tasks/wave-oct/T7-ai-share-of-voice.md) owns this file and replaces the throwing
// bodies. The signatures below are the wave contract (CONTRACT.md §3) — every caller in the
// wave compiles against them from the first commit.

import type { AiCompetitor, CitedDomainRow, SovReport, SuggestedQuestion } from "./types";

export async function sovForSite(userId: string, siteDbId: string, days: number): Promise<{ report: SovReport; cited: CitedDomainRow[] } | null> {
  throw new Error("wave: sovForSite not implemented (T7)");
}

export async function getCompetitors(userId: string, siteDbId: string): Promise<AiCompetitor[]> {
  throw new Error("wave: getCompetitors not implemented (T7)");
}

export async function saveCompetitors(userId: string, siteDbId: string, list: AiCompetitor[]): Promise<void> {
  throw new Error("wave: saveCompetitors not implemented (T7)");
}

export async function suggestQuestions(userId: string, siteDbId: string, limit: number): Promise<SuggestedQuestion[]> {
  throw new Error("wave: suggestQuestions not implemented (T7)");
}
