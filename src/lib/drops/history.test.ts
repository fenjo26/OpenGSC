import assert from "node:assert/strict";
import test from "node:test";
import { extractText, parseHistoryVerdict, pickSnapshotTimestamps } from "./history";

test("snapshot picks spread across the domain's life: first, middle, last", () => {
  const months = ["2012","2013","2014","2015","2016","2017","2018","2019","2020"].map(y => `${y}0601000000`);
  assert.deepEqual(
    pickSnapshotTimestamps(months).map(t => t.slice(0, 4)),
    ["2012", "2016", "2020"],
  );
  // Fewer months than picks: everything, unchanged.
  assert.deepEqual(pickSnapshotTimestamps(["20150101000000", "20160101000000"]).length, 2);
  // Duplicates collapse before spreading.
  assert.equal(pickSnapshotTimestamps(["20150101000000", "20150101000000"]).length, 1);
});

test("archived HTML turns into readable text without scripts or markup", () => {
  const html = `<html><head><style>body{color:red}</style><script>evil()</script></head>
    <body><h1>Стройка&nbsp;и ремонт</h1><p>Keywords &amp; phrases</p></body></html>`;
  const text = extractText(html);
  assert.ok(text.includes("Стройка и ремонт"));
  assert.ok(text.includes("Keywords & phrases"));
  assert.ok(!text.includes("evil"));
  assert.ok(!text.includes("<"));
});

test("the AI reply parses even when the model wraps it in prose or fences", () => {
  const fenced = 'Here you go:\n```json\n{"verdict": "topic_shift", "note": "was a construction site, later a casino affiliate page."}\n```';
  assert.deepEqual(
    parseHistoryVerdict(fenced, "example.gr"),
    { verdict: "topic_shift", note: "was a construction site, later a casino affiliate page." },
  );
});

test("an unreadable reply becomes unknown, never clean by default", () => {
  assert.equal(parseHistoryVerdict(null, "x.gr").verdict, "unknown");
  assert.equal(parseHistoryVerdict("the model rambled", "x.gr").verdict, "unknown");
  assert.equal(parseHistoryVerdict('{"verdict": "excellent", "note": ""}', "x.gr").verdict, "unknown");
  assert.ok(parseHistoryVerdict("the model rambled", "x.gr").note.includes("rambled"));
});
