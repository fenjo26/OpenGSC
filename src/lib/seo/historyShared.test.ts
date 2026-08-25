import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_TYPE, textDiagnostics } from "./historyShared";

// The shared job→history mapper runs on BOTH sides of the import: the server writes the row
// (saveJobToHistory) the moment a job completes, and the browser adopts the same job locally.
// If the two mappings drift, one job ends up filed twice under different ids — these lock the
// shapes together.

test("HISTORY_TYPE files outline_auto as a regular outline and knows every job type", () => {
  assert.equal(HISTORY_TYPE.outline_auto, "outline");
  assert.equal(HISTORY_TYPE.outline, "outline");
  assert.equal(HISTORY_TYPE.text, "text");
  assert.equal(HISTORY_TYPE.analysis, "analysis");
  assert.equal(HISTORY_TYPE.landing, "landing");
  assert.equal(HISTORY_TYPE.cluster, "cluster");
});

test("textDiagnostics carries every generator finding the article string cannot hold", () => {
  const d = textDiagnostics({
    text: "article body",
    mechanics: [{ code: "placeholder", detail: "dropped [[WIDGET]]", fixed: true }],
    judgeConcerns: ["thin FAQ"],
    usedSources: 3,
    autoCleaned: true,
    incomplete: true,
    missingHeadings: ["H2: Pricing"],
  });
  assert.deepEqual(d, {
    mechanics: [{ code: "placeholder", detail: "dropped [[WIDGET]]", fixed: true }],
    judgeConcerns: ["thin FAQ"],
    usedSources: 3,
    autoCleaned: true,
    incomplete: true,
    missingHeadings: ["H2: Pricing"],
  });
});

test("textDiagnostics skips absent findings instead of storing undefined holes", () => {
  assert.deepEqual(textDiagnostics({ text: "clean run", usedSources: 0 }), { usedSources: 0 });
  assert.equal(textDiagnostics({ text: "nothing reported" }), null);
});

test("textDiagnostics rejects non-objects a job result can degrade into", () => {
  assert.equal(textDiagnostics(null), null);
  assert.equal(textDiagnostics("plain string result"), null);
});
