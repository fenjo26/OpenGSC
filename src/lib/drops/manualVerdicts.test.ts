import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManualVerdicts, parseVerdictCell } from "./manualVerdicts";

// The file comes back from someone else's template, so the parser has to be tolerant about
// shape — and completely intolerant about guessing a verdict that is not there.

test("domain and verdict are found in either order, with any usual separator", () => {
  const { rows } = parseManualVerdicts([
    "kylistours.gr,available",
    "taken;cyclorama.gr",
    "iqweb.gr\tregistered",
    "https://www.holidaybook.gr/x | свободен",
  ].join("\n"));
  assert.deepEqual(rows, [
    { domain: "kylistours.gr", verdict: "available" },
    { domain: "cyclorama.gr", verdict: "registered" },
    { domain: "iqweb.gr", verdict: "registered" },
    { domain: "holidaybook.gr", verdict: "available" },
  ]);
});

test("a row with no verdict is dropped, never read as free", () => {
  // Silence from the tool is the absence of an answer. Turning it into "go ahead and buy" is
  // the one mistake in this file that costs money.
  const { rows, skipped } = parseManualVerdicts("kylistours.gr\ncyclorama.gr,\n");
  assert.deepEqual(rows, []);
  assert.equal(skipped.filter(s => s.reason === "no_verdict").length, 2);
});

test("bare 1/0 and yes/no are not verdicts", () => {
  assert.equal(parseVerdictCell("1"), null);
  assert.equal(parseVerdictCell("yes"), null);
  assert.equal(parseVerdictCell("available"), "available");
  assert.equal(parseVerdictCell("  Занят "), "registered");
});

test("a domain called both free and taken is thrown out, not guessed", () => {
  const { rows, skipped } = parseManualVerdicts("x.gr,available\nx.gr,registered\n");
  assert.deepEqual(rows, []);
  assert.equal(skipped.filter(s => s.reason === "conflict").length, 1);
});

test("a repeated row that agrees with itself is not a conflict", () => {
  const { rows, skipped } = parseManualVerdicts("x.gr,available\nx.gr,available\n");
  assert.deepEqual(rows, [{ domain: "x.gr", verdict: "available" }]);
  assert.equal(skipped.length, 0);
});

test("comments and blank lines pass through without noise in the report", () => {
  const { rows, skipped } = parseManualVerdicts("# exported 2026-09-10\n\nx.gr,available\n");
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 0);
});

test("junk is reported as junk", () => {
  const { rows, skipped } = parseManualVerdicts("not a domain at all,available\n192.0.2.1,available\n");
  assert.deepEqual(rows, []);
  assert.equal(skipped.filter(s => s.reason === "no_domain").length, 2);
});
