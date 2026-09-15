// SERP Monitor — host-level diff. Stub: T2 owns the implementation (see docs/tasks/serp-monitor/).
import type { HostPos, KeywordDiff, SerpRow } from "./types";

/** Host list in order of best position, rows beyond `depth` ignored. */
export function hostPositions(rows: SerpRow[], depth: number): HostPos[] {
  throw new Error("serpmon: hostPositions not implemented (T2)");
}

export function diffKeyword(
  prev: SerpRow[], cur: SerpRow[],
  opts: { depth: number; ignore: (host: string) => boolean },
): KeywordDiff {
  throw new Error("serpmon: diffKeyword not implemented (T2)");
}
