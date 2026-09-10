import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCandidateFilter } from "./store";

// parseCandidateFilter is the one parser every filter surface shares — the table's GET query,
// the bulk "выбрать все по фильтру" body, the registry check's filter, and the MCP tools. A
// value parsed differently on any two of those surfaces means the table showed one set of rows
// and a bulk action touched another, so the contract is pinned here: numbers from strings or
// numbers, "1"/1/true booleans, junk dropped to undefined, unknown stages never passed through.

test("numeric ranges parse from strings and numbers alike", () => {
  const fromQuery = parseCandidateFilter({ drMin: "10", drMax: "5", refMin: "300", tfMax: "40" });
  assert.deepEqual(
    { drMin: fromQuery.drMin, drMax: fromQuery.drMax, refMin: fromQuery.refMin, tfMax: fromQuery.tfMax },
    { drMin: 10, drMax: 5, refMin: 300, tfMax: 40 },
  );
  const fromJson = parseCandidateFilter({ drMax: 10 });
  assert.equal(fromJson.drMax, 10);
});

test("junk numeric values drop to undefined, not zero", () => {
  const f = parseCandidateFilter({ drMin: "abc", refMax: "", tfMin: "  ", minScore: null });
  assert.equal(f.drMin, undefined);
  assert.equal(f.refMax, undefined);
  assert.equal(f.tfMin, undefined);
  assert.equal(f.minScore, undefined);
});

test("drNull/ungrouped/starred/watched accept the 1, 1-string and true spellings", () => {
  for (const v of ["1", 1, true]) {
    const f = parseCandidateFilter({ drNull: v, ungrouped: v, starred: v, watched: v });
    assert.equal(f.drNull, true);
    assert.equal(f.ungrouped, true);
    assert.equal(f.starred, true);
    assert.equal(f.watched, true);
  }
  const off = parseCandidateFilter({ drNull: "0", ungrouped: 0, starred: false });
  assert.equal(off.drNull, undefined);
  assert.equal(off.ungrouped, undefined);
  assert.equal(off.starred, undefined);
});

test("an unknown stage or source is dropped, not passed through", () => {
  const f = parseCandidateFilter({ stage: "hacked", source: "nope" });
  assert.equal(f.stage, undefined);
  assert.equal(f.source, undefined);
  assert.equal(parseCandidateFilter({ stage: "available" }).stage, "available");
});

test("tld folds case and loses its dot; empty strings vanish", () => {
  const f = parseCandidateFilter({ tld: ".GR", q: "  casino  " });
  assert.equal(f.tld, "gr");
  assert.equal(f.q, "  casino  ");
  const empty = parseCandidateFilter({ tld: "", runId: "", groupId: "" });
  assert.equal(empty.tld, undefined);
  assert.equal(empty.runId, undefined);
  assert.equal(empty.groupId, undefined);
});
