// T6 (docs/tasks/wave-oct/T6-mentions.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { MentionHit, MentionTerm } from "./types";

export async function fetchNews(t: MentionTerm, lang: string, country: string): Promise<MentionHit[]> {
  throw new Error("wave: fetchNews not implemented (T6)");
}

export async function fetchWikipedia(terms: MentionTerm[], host: string, lang: string): Promise<MentionHit[]> {
  throw new Error("wave: fetchWikipedia not implemented (T6)");
}

export async function fetchWikidata(host: string, name: string): Promise<MentionHit[]> {
  throw new Error("wave: fetchWikidata not implemented (T6)");
}
