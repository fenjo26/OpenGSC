// One number to sort the catalogue by.
//
// Deliberately a short arithmetic formula in a pure module rather than an expression inside a
// SQL ORDER BY. Two reasons: it can be tested, and it can be explained to the user row by row —
// "why is this 62 and that 31" is the first question anyone asks of a ranked list, and a formula
// buried in a query cannot answer it.
//
// The weights are a starting point, not a finding. They will be wrong until a few dozen domains
// have been bought and watched.

import type { ScoreInput, HistoryVerdict } from "./types";

const HISTORY_WEIGHT: Record<HistoryVerdict, number> = {
  // A clean, single-topic past is the strongest signal there is and the hardest to fake.
  clean: 20,
  // The name changed hands and topics. Usable, but the link profile probably points at
  // something the new site will not be about.
  topic_shift: 5,
  // Pharma/casino/foreign-language spam between death and now. Whatever the metrics say, the
  // links pointing here have been living next to that for years.
  spam_period: -30,
  // Not looked at yet. Not a penalty — an absence.
  unknown: 0,
};

/** Long-dead names lose links every month; four years is where the profile stops resembling the metrics. */
const STALE_DAYS = 1460;

export interface ScoreBreakdown {
  score: number;
  parts: { label: string; value: number }[];
}

/**
 * The score plus its terms. Callers that only need the number use `scoreCandidate`; the domain
 * card renders the breakdown.
 */
export function scoreCandidateDetailed(c: ScoreInput): ScoreBreakdown {
  const parts: { label: string; value: number }[] = [];

  // Dofollow referring domains, log-scaled. Linear would let one 400-domain outlier bury
  // everything else in the list, and the difference between 5 and 15 donors matters far more
  // than the difference between 300 and 310.
  const dofollow = num(c.refdomainsDofollow) ?? num(c.refdomains) ?? 0;
  parts.push({ label: "refdomains", value: round(Math.log10(dofollow + 1) * 30) });

  // DR is a vendor's opinion, not a measurement, so it is a contributor rather than the axis.
  const dr = clamp(num(c.dr) ?? 0, 0, 100);
  parts.push({ label: "dr", value: round(dr * 1.5) });

  const verdict = c.historyVerdict ?? "unknown";
  parts.push({ label: "history", value: HISTORY_WEIGHT[verdict] ?? 0 });

  // A domain nobody archived is a domain that never had readers.
  const snapshots = num(c.waybackSnapshots);
  if (snapshots !== null) {
    parts.push({ label: "snapshots", value: snapshots === 0 ? -10 : round(Math.min(Math.log10(snapshots + 1) * 8, 12)) });
  }

  const gap = num(c.waybackGapDays);
  if (gap !== null && gap > STALE_DAYS) {
    parts.push({ label: "stale", value: -15 });
  }

  const score = round(parts.reduce((sum, p) => sum + p.value, 0));
  return { score, parts };
}

export function scoreCandidate(c: ScoreInput): number {
  return scoreCandidateDetailed(c).score;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
