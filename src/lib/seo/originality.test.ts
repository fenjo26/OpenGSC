import { test } from "node:test";
import assert from "node:assert/strict";
import { originalityReport, originalityBrief, bandFor, ORIG_NEAR_DUP } from "./originality";

// A geo template: same body, city swapped. The case the whole module exists for.
const body = (city: string) =>
  `## Roof repair in ${city}\n\nWe repair and replace roofs in ${city} and the surrounding area. ` +
  `Our team handles flat roofs, tiled roofs and metal roofs, with a written estimate before any work starts. ` +
  `Every job comes with a guarantee and a final inspection, and we clean the site when we leave. ` +
  `Call us for a free quote in ${city}; most inspections are booked within a few days and take about an hour. ` +
  `We use quality materials from trusted suppliers and our roofers are trained and insured for work at height. ` +
  `Whether you need a small leak fixed or a complete new roof, we explain the options and the costs clearly.`;

const siblings = ["Leeds", "York", "Hull", "Bradford"].map(body);

test("a city-swapped template is a template", () => {
  const r = originalityReport(body("Sheffield"), siblings);
  assert.equal(r.siblings, 4);
  assert.ok(r.shingles.maxSimilarity >= ORIG_NEAR_DUP, `similarity ${r.shingles.maxSimilarity}`);
  assert.equal(r.band, "template");
  assert.equal(r.substance.unique.length, 0);
});

test("real per-city substance moves the substance layer, not just the shingles", () => {
  const extra =
    `\n\n## Recent jobs in Sheffield\n\nIn March 2025 we re-roofed a 1930s semi on Ecclesall Road: 84 m² of slate, ` +
    `finished in 6 days for £9,400. A flat roof on Abbeydale Road (32 m², EPDM) took 2 days.\n\n` +
    `| Job | Area | Days | Price |\n|---|---|---|---|\n| Slate re-roof | 84 m² | 6 | £9,400 |\n| EPDM flat roof | 32 m² | 2 | £2,150 |\n\n` +
    `## What Sheffield customers said\n\n"The crew from [our Ecclesall Road job](/jobs/ecclesall) left the drive spotless" — M. Hartley, S11.`;
  const before = originalityReport(body("Sheffield"), siblings);
  const after = originalityReport(body("Sheffield") + extra, siblings);
  assert.ok(after.score > before.score + 25, `${before.score} → ${after.score}`);
  assert.ok(after.substance.unique.length >= 5, after.substance.unique.join(", "));
  assert.equal(after.structure.hasTable, true);
  assert.ok(after.structure.uniqueHeadings.length >= 2);
  assert.ok(after.structure.uniqueAnchors.length >= 1);
  assert.notEqual(after.band, "template");
});

test("a shared fact does not count as original", () => {
  const sib = body("Leeds") + " Prices start at £450 for a repair visit, with 10 years guarantee.";
  const r = originalityReport(body("Leeds") + " Prices start at £450 for a repair visit, with 10 years guarantee.", [sib]);
  assert.equal(r.substance.unique.length, 0);
  assert.ok(r.substance.shared >= 2);
});

test("single digits are not substance", () => {
  const r = originalityReport(body("Leeds") + " Step 1, step 2, step 3.", [body("Leeds")]);
  assert.deepEqual(r.substance.unique, []);
});

test("no siblings → nothing measured against", () => {
  const r = originalityReport(body("Leeds"), []);
  assert.equal(r.siblings, 0);
  assert.equal(r.shingles.closest, -1);
});

test("near-duplicate similarity overrides a high score", () => {
  assert.equal(bandFor(90, 0.85), "template");
  assert.equal(bandFor(90, 0.5), "original");
  assert.equal(bandFor(45, 0.5), "borderline");
});

test("the brief forbids invention when no facts are supplied", () => {
  const r = originalityReport(body("Sheffield"), siblings);
  assert.match(originalityBrief(r, ""), /do NOT invent/);
  const withFacts = originalityBrief(r, "84 m² slate re-roof, £9,400, March 2025");
  assert.match(withFacts, /£9,400/);
  assert.match(withFacts, /Markdown table/);
});
