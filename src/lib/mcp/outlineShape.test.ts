import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceOutline } from "./outlineShape";

// The outline the pipeline actually produces: meta (with the facts bank) + sections + faq.
const outline = {
  meta: { h1: "Τίτλος", keyword: "καθαρισμός σπιτιού", language: "el", facts_bank: [{ source: "https://x", facts: "€25/ωρα" }] },
  sections: [{ h_level: "H2", heading: "Τιμές", summary: "…" }],
  faq: [{ question: "Πόσο;" }],
};

test("coerceOutline accepts a real outline object as-is", () => {
  assert.equal(coerceOutline(outline), outline);
});

test("coerceOutline parses a JSON-stringified outline", () => {
  assert.deepEqual(coerceOutline(JSON.stringify(outline)), outline);
});

test("coerceOutline unwraps the shapes an agent naturally passes", () => {
  // a get_generations record
  assert.equal(coerceOutline({ id: "1", type: "outline", keyword: "k", data: outline }), outline);
  // a get_generation_job response
  assert.equal(coerceOutline({ jobId: "j1", type: "outline", status: "completed", result: outline }), outline);
  // a landing result
  assert.equal(coerceOutline({ outline, wireframe: { blocks: [] }, text: "…" }), outline);
  // nested wrappers
  assert.equal(coerceOutline({ data: { result: outline } }), outline);
});

test("coerceOutline rejects everything that is not an outline", () => {
  // the exact failure that produced full-price articles about the wrong subject: a job
  // response whose result never made it in, an article string, an empty outline, garbage
  assert.equal(coerceOutline({ jobId: "j1", type: "text", status: "completed", result: null }), null);
  assert.equal(coerceOutline("# Η τελική"), null);
  assert.equal(coerceOutline("just some text"), null);
  assert.equal(coerceOutline({ meta: {}, sections: [], faq: [] }), null);
  assert.equal(coerceOutline(undefined), null);
  assert.equal(coerceOutline(42), null);
  assert.equal(coerceOutline(["not", "an", "outline"]), null);
});
