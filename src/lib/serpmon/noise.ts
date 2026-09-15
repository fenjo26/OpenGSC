// SERP Monitor — snapshot validity / comparability. Stub: T2 owns the implementation (see docs/tasks/serp-monitor/).
import type { SerpRow, SnapshotProblem, SnapshotStatus } from "./types";

export function classifySnapshot(input: {
  rows: SerpRow[];
  depth: number;
  totalCount: string | null;            // engine-reported; "" / null = unknown
  providerError: string | null;         // SerpResponse.error
}): { status: SnapshotStatus; problem: SnapshotProblem | null } {
  throw new Error("serpmon: classifySnapshot not implemented (T2)");
}

/** The depth two snapshots can be compared at. 0 = not comparable. */
export function comparableDepth(
  prev: { status: SnapshotStatus; got: number } | null,
  cur: { status: SnapshotStatus; got: number },
): number {
  throw new Error("serpmon: comparableDepth not implemented (T2)");
}
