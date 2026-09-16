import { test } from "node:test";
import assert from "node:assert/strict";
import { aparserPasswordCandidates } from "../seo/aparserCredCandidates";

test("env first, then settings", () => {
  assert.deepEqual(aparserPasswordCandidates("old", "new"), [
    { source: "env", password: "old" },
    { source: "settings", password: "new" },
  ]);
});

test("equal passwords collapse to the env candidate", () => {
  assert.deepEqual(aparserPasswordCandidates("same", " same "), [{ source: "env", password: "same" }]);
});

test("blanks are dropped", () => {
  assert.deepEqual(aparserPasswordCandidates("", "new"), [{ source: "settings", password: "new" }]);
  assert.deepEqual(aparserPasswordCandidates("  ", ""), []);
  assert.deepEqual(aparserPasswordCandidates("old", ""), [{ source: "env", password: "old" }]);
});
