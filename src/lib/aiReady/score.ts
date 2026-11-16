// AI Readiness score — pure, no I/O. Weights and thresholds are the contract's §6.
//
// Two rules shape every function here:
//   • an unread input is excluded and the remaining weights are renormalised — it never
//     counts as zero;
//   • the result always names the parts it was built from (`coverage`), because a score made of
//     one part and a score made of three are different numbers that happen to share a scale.

import type {
  AccessPart, AiReadyGrade, AiReadyPartName, AiReadyScore, PresencePart, RankPart,
} from "./types";

export const PART_WEIGHTS: Record<AiReadyPartName, number> = { access: 50, presence: 20, rank: 30 };
export const ACCESS_WEIGHTS = { robots: 45, parity: 45, llms: 10 } as const;
export const GRADE_FLOORS: Array<[AiReadyGrade, number]> = [["A", 85], ["B", 70], ["C", 55], ["D", 40], ["E", 25], ["F", 0]];

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Weighted mean over the entries that have a value; null when none has. */
function weighted(entries: Array<[number | null, number]>): number | null {
  let sum = 0, weight = 0;
  for (const [value, w] of entries) {
    if (value == null || !Number.isFinite(value)) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

export function accessScore(part: AccessPart | undefined): number | null {
  if (!part) return null;
  const { crawl, parity } = part;

  // robots.txt: share of AI bots not root-blocked. A file we failed to read leaves every bot
  // "unknown" — excluded, not counted as allowed.
  const knownBots = crawl.bots.filter(b => b.status !== "unknown");
  const robots = knownBots.length ? (100 * knownBots.filter(b => b.status === "allowed").length) / knownBots.length : null;

  // Parity: share of bot identities served the browser's page. Network errors are excluded
  // (they say nothing about policy); an inconclusive baseline excludes the whole component.
  const judged = parity.conclusive ? parity.rows.filter(r => r.verdict !== "error" && r.verdict !== "inconclusive") : [];
  const parityScore = judged.length ? (100 * judged.filter(r => r.verdict === "same").length) / judged.length : null;

  // /llms.txt: present = full marks, cleanly missing = none, unreadable = excluded.
  const llms = crawl.llmsTxt.status === "failed" ? null : crawl.llmsTxt.present ? 100 : 0;

  const score = weighted([[robots, ACCESS_WEIGHTS.robots], [parityScore, ACCESS_WEIGHTS.parity], [llms, ACCESS_WEIGHTS.llms]]);
  return score == null ? null : Math.round(clamp(score));
}

export function presenceScore(part: PresencePart | undefined): number | null {
  if (!part) return null;
  const known = part.months.filter(m => m.present !== null); // newest first
  if (!known.length) return null;
  const share = known.filter(m => m.present).length / known.length;
  const latest = known[0].present ? 30 : 0;
  return Math.round(clamp(share * 70 + latest));
}

export function authorityScore(part: RankPart | undefined): number | null {
  if (!part) return null;
  if (part.status !== "ok" && part.status !== "not_found") return null;
  return part.authority == null ? null : Math.round(clamp(part.authority));
}

export function gradeFor(score: number): AiReadyGrade {
  for (const [grade, floor] of GRADE_FLOORS) if (score >= floor) return grade;
  return "F";
}

export function computeScore(input: { access?: AccessPart; presence?: PresencePart; rank?: RankPart }): AiReadyScore {
  const access = accessScore(input.access);
  const presence = presenceScore(input.presence);
  const authority = authorityScore(input.rank);
  const total = weighted([[access, PART_WEIGHTS.access], [presence, PART_WEIGHTS.presence], [authority, PART_WEIGHTS.rank]]);
  const coverage: AiReadyPartName[] = [];
  if (access != null) coverage.push("access");
  if (presence != null) coverage.push("presence");
  if (authority != null) coverage.push("rank");
  const score = total == null ? null : Math.round(clamp(total));
  return { score, grade: score == null ? null : gradeFor(score), parts: { access, presence, authority }, coverage };
}

// ─── Rank tier ────────────────────────────────────────────────────────────────
//
// A name for the order of magnitude of a rank position, shown beside the authority part. It is
// a label, not a grade: it does not enter the score and deliberately carries no letter, so the
// card never shows two different letters for one site.

export type RankTier = "elite" | "authoritative" | "established" | "strong" | "emerging" | "unranked";

export const TIER_CEILINGS: Array<[RankTier, number]> = [
  ["elite", 1_000], ["authoritative", 10_000], ["established", 100_000], ["strong", 1_000_000], ["emerging", 10_000_000],
];

/** Tier of a harmonic-centrality position; null/absent or beyond the top 10 M is "unranked". */
export function rankTier(hcRank: number | null | undefined): RankTier {
  if (!hcRank || hcRank < 1) return "unranked";
  for (const [tier, ceiling] of TIER_CEILINGS) if (hcRank <= ceiling) return tier;
  return "unranked";
}

/** "2.2M", "45K", "812" — a rank position short enough to sit next to the tier name. */
export function compactRank(hcRank: number): string {
  if (hcRank >= 999_500) return `${(hcRank / 1_000_000).toFixed(hcRank >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (hcRank >= 1_000) return `${(hcRank / 1_000).toFixed(hcRank >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(hcRank);
}
