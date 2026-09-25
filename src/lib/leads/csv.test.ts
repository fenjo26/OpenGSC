import test from "node:test";
import assert from "node:assert/strict";

// N9 — CSV export of the lead inbox. A lead's domain, name and message are visitor-typed
// text, so the export must survive the CSV/formula injection family (=, +, -, @ at the
// start of a cell) as well as RFC 4180 quoting.

import { csvCell, leadsToCsv } from "./csv";

test("csvCell prefixes = + - @ tab and CR at the start of a cell with a quote", () => {
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("\tTAB"), "'\tTAB");
  // A CR at the start triggers the guard AND RFC 4180 quoting — both defences compose.
  assert.equal(csvCell("\rCR"), `"'\rCR"`);
  // Innocent values pass through untouched.
  assert.equal(csvCell("example.com"), "example.com");
  assert.equal(csvCell("42"), "42");
  assert.equal(csvCell(null), "");
});

test("csvCell quotes RFC 4180-special characters and doubles embedded quotes", () => {
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  // Both defences compose: formula-guard first, then quoting of the guarded value.
  assert.equal(csvCell("=a,b"), '"\'=a,b"');
});

test("a minus INSIDE a cell is not a formula and is not guarded", () => {
  assert.equal(csvCell("some-domain.example"), "some-domain.example");
  assert.equal(csvCell("user@example.com"), "user@example.com"); // @ inside is fine too
});

test("leadsToCsv emits a header and one row per lead with escaped cells", () => {
  const csv = leadsToCsv([
    {
      createdAt: "2026-01-02T03:04:05.000Z",
      domain: "=HYPERLINK(\"https://evil\")",
      email: "lead@client.example",
      name: "Ann",
      score: 41,
      status: "new",
      source: "widget",
      origin: "https://agency.example/",
      top: ["Broken links", "No <title>"],
    },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "date,domain,email,name,score,status,source,origin,top_issues");
  assert.ok(lines[1].includes("'=HYPERLINK"));
  assert.ok(lines[1].includes("lead@client.example"));
  assert.ok(lines[1].includes("Broken links; No <title>"));
  assert.ok(csv.endsWith("\r\n"));
});
