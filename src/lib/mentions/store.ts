// T6 (docs/tasks/wave-oct/T6-mentions.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { MentionLinkStatus, MentionQuery, MentionRow, MentionSettings } from "./types";

export async function runMentions(userId: string, siteDbId: string): Promise<{ found: number; inserted: number; errors: string[] }> {
  throw new Error("wave: runMentions not implemented (T6)");
}

export async function listMentions(userId: string, siteDbId: string, q: MentionQuery): Promise<{ total: number; rows: MentionRow[] } | { notMigrated: true }> {
  throw new Error("wave: listMentions not implemented (T6)");
}

export async function updateMention(userId: string, id: string, patch: { reviewed?: boolean; dismissed?: boolean }): Promise<void> {
  throw new Error("wave: updateMention not implemented (T6)");
}

export async function checkMentionLink(userId: string, id: string): Promise<MentionLinkStatus> {
  throw new Error("wave: checkMentionLink not implemented (T6)");
}

export async function getMentionSettings(userId: string, siteDbId: string): Promise<MentionSettings> {
  throw new Error("wave: getMentionSettings not implemented (T6)");
}

export async function saveMentionSettings(userId: string, siteDbId: string, s: MentionSettings): Promise<void> {
  throw new Error("wave: saveMentionSettings not implemented (T6)");
}
