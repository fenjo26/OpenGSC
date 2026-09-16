// SERP Monitor — snapshot validity / comparability (CONTRACT.md §3.2, §0 trap 1: a failed shot is never an empty SERP).
// Pure module: imported by both server and client code — no server-only imports here.
import type { SerpRow, SnapshotProblem, SnapshotStatus } from "./types";
import { SHORT_RESULT_RATIO } from "./types";

/** Every SnapshotProblem code; providerError matching one verbatim keeps that code (T1 sends codes unprefixed). */
const KNOWN_PROBLEMS: readonly SnapshotProblem[] = [
  "aparser_no_result",
  "aparser_parser_failed",
  "aparser_blocked_or_empty",
  "short_result",
  "provider_error",
  "no_creds",
  "timeout",
  "suspicious_links",
];

/** "1 230 000" / "1,230,000" / "1.230.000" → 1230000. Anything else → null (unknown). */
function parseTotalCount(raw: string | null): number | null {
  if (raw == null) return null;
  const digits = raw.replace(/[\s\u00a0\u202f.,'’`]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export function classifySnapshot(input: {
  rows: SerpRow[];
  depth: number;
  totalCount: string | null;            // engine-reported; "" / null = unknown
  providerError: string | null;         // SerpResponse.error
}): { status: SnapshotStatus; problem: SnapshotProblem | null } {
  const error = input.providerError?.trim();
  if (error) {
    if ((KNOWN_PROBLEMS as readonly string[]).includes(error)) {
      return { status: "failed", problem: error as SnapshotProblem };
    }
    if (error.toLowerCase().includes("timeout")) {
      return { status: "failed", problem: "timeout" };
    }
    return { status: "failed", problem: "provider_error" };
  }

  const total = parseTotalCount(input.totalCount);

  if (input.rows.length === 0) {
    // A genuinely empty SERP: the engine explicitly reported zero results.
    if (total === 0) return { status: "ok", problem: null };
    // Empty answer without an engine verdict — proxies blocked or captcha, NOT "the SERP is empty".
    return { status: "failed", problem: "aparser_blocked_or_empty" };
  }

  const expected = total === null ? input.depth : Math.min(input.depth, total);
  if (input.rows.length >= Math.ceil(SHORT_RESULT_RATIO * expected)) {
    return { status: "ok", problem: null };
  }
  return { status: "partial", problem: "short_result" };
}

/** The depth two snapshots can be compared at. 0 = not comparable. */
export function comparableDepth(
  prev: { status: SnapshotStatus; got: number } | null,
  cur: { status: SnapshotStatus; got: number },
): number {
  if (!prev || prev.status === "failed" || cur.status === "failed") return 0;
  return Math.min(prev.got, cur.got);
}
