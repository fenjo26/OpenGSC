import assert from "node:assert/strict";
import test from "node:test";
import { classifySnapshot, comparableDepth } from "./noise";
import type { SerpRow, SnapshotStatus } from "./types";

function rows(n: number, startAt = 1): SerpRow[] {
  return Array.from({ length: n }, (_, i) => ({
    position: startAt + i,
    url: `https://site${startAt + i}.test/p`,
    host: `site${startAt + i}.test`,
    title: "",
  }));
}

function classify(over: {
  rows?: SerpRow[];
  depth?: number;
  totalCount?: string | null;
  providerError?: string | null;
}): { status: SnapshotStatus; problem: string | null } {
  return classifySnapshot({
    rows: over.rows ?? [],
    depth: over.depth ?? 100,
    totalCount: over.totalCount ?? null,
    providerError: over.providerError ?? null,
  });
}

test("full and near-full snapshots are ok (ceil(0.8 × 100) = 80)", () => {
  assert.deepEqual(classify({ rows: rows(100), totalCount: "1 230 000" }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: rows(85) }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: rows(80) }), { status: "ok", problem: null }); // exact boundary
  assert.deepEqual(classify({ rows: rows(79) }), { status: "partial", problem: "short_result" });
});

test("totalCount below depth lowers the expectation", () => {
  assert.deepEqual(classify({ rows: rows(12), totalCount: "12" }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: rows(10), totalCount: "12" }), { status: "ok", problem: null }); // ceil(9.6) = 10
  assert.deepEqual(classify({ rows: rows(9), totalCount: "12" }), { status: "partial", problem: "short_result" });
  assert.deepEqual(classify({ rows: rows(45), totalCount: "50" }), { status: "ok", problem: null }); // ceil(40) = 40
  assert.deepEqual(classify({ rows: rows(39), totalCount: "50" }), { status: "partial", problem: "short_result" });
});

test("thousand separators are stripped before totalCount is parsed", () => {
  // "0,050" parses to 50 only once separators are stripped: expectation 50 → 45 rows are complete.
  for (const total of ["0,050", "0.050", "0 050", "50"]) {
    assert.deepEqual(
      classify({ rows: rows(45), totalCount: total }),
      { status: "ok", problem: null },
      `totalCount "${total}"`,
    );
  }
  // Big counts with separators stay numbers; depth caps the expectation.
  assert.deepEqual(classify({ rows: rows(60), totalCount: "1,230,000" }), { status: "partial", problem: "short_result" });
  assert.deepEqual(classify({ rows: rows(80), totalCount: "1 230 000" }), { status: "ok", problem: null });
  // Unparsable text → unknown → expectation = depth.
  assert.deepEqual(classify({ rows: rows(60), totalCount: "about a million" }), { status: "partial", problem: "short_result" });
  assert.deepEqual(classify({ rows: rows(80), totalCount: "about a million" }), { status: "ok", problem: null });
});

test("empty result is ok only when the engine reports zero", () => {
  assert.deepEqual(classify({ rows: [], totalCount: "0" }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: [], totalCount: "0.000" }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: [] }), { status: "failed", problem: "aparser_blocked_or_empty" });
  assert.deepEqual(classify({ rows: [], totalCount: "" }), { status: "failed", problem: "aparser_blocked_or_empty" });
  assert.deepEqual(classify({ rows: [], totalCount: "1 230 000" }), { status: "failed", problem: "aparser_blocked_or_empty" });
});

test("providerError wins over everything and maps to known codes verbatim", () => {
  assert.deepEqual(
    classify({ rows: rows(100), totalCount: "1000", providerError: "aparser_parser_failed" }),
    { status: "failed", problem: "aparser_parser_failed" },
  );
  assert.deepEqual(
    classify({ rows: [], totalCount: "0", providerError: "aparser_blocked_or_empty" }),
    { status: "failed", problem: "aparser_blocked_or_empty" },
  );
  assert.deepEqual(classify({ rows: rows(10), providerError: "no_creds" }), { status: "failed", problem: "no_creds" });
  assert.deepEqual(classify({ rows: rows(10), providerError: "timeout" }), { status: "failed", problem: "timeout" });
  assert.deepEqual(
    classify({ rows: rows(10), providerError: "сеть A-Parser (host:9091): timeout" }),
    { status: "failed", problem: "timeout" },
  );
  assert.deepEqual(classify({ rows: rows(10), providerError: "boom" }), { status: "failed", problem: "provider_error" });
  assert.deepEqual(classify({ rows: rows(10), providerError: "aparser_no_result" }), { status: "failed", problem: "aparser_no_result" });
});

test("an empty (or whitespace) providerError is no error at all", () => {
  assert.deepEqual(classify({ rows: rows(100), providerError: "" }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: rows(100), providerError: "   " }), { status: "ok", problem: null });
  assert.deepEqual(classify({ rows: rows(79), providerError: "" }), { status: "partial", problem: "short_result" });
});

test("comparableDepth over all status combinations", () => {
  const ok = (got: number) => ({ status: "ok" as const, got });
  const partial = (got: number) => ({ status: "partial" as const, got });
  const failed = { status: "failed" as const, got: 0 };
  assert.equal(comparableDepth(null, ok(100)), 0); // nothing to compare with
  assert.equal(comparableDepth(failed, ok(100)), 0);
  assert.equal(comparableDepth(partial(50), failed), 0);
  assert.equal(comparableDepth(failed, failed), 0);
  assert.equal(comparableDepth(ok(100), ok(100)), 100);
  assert.equal(comparableDepth(ok(100), partial(60)), 60);
  assert.equal(comparableDepth(partial(60), ok(100)), 60);
  assert.equal(comparableDepth(partial(40), partial(90)), 40);
});
