import { test } from "node:test";
import assert from "node:assert/strict";
import { fillHolesFromPrevious } from "./repair";
import type { SerpRow } from "./types";

const row = (position: number, host: string, title: string): SerpRow =>
  ({ position, url: `https://${host}/`, host, title });

test("a hole takes the previous take's URL for the same title", () => {
  const prev = [row(1, "a.gr", "A site"), row(2, "b.gr", "NV Casino Greece:  Επίσημο Site"), row(3, "c.gr", "C")];
  const cur = [row(1, "a.gr", "A site"), row(3, "c.gr", "C")];
  const r = fillHolesFromPrevious(cur, [{ position: 2, title: "nv casino greece: επίσημο site" }], prev);
  assert.deepEqual(r.filled, [2]);
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.rows.map(x => x.host), ["a.gr", "b.gr", "c.gr"]);
});

test("unknown, ambiguous or already present titles leave the hole empty", () => {
  const prev = [row(1, "a.gr", "Same"), row(2, "b.gr", "Same"), row(3, "c.gr", "C")];
  const cur = [row(1, "c.gr", "C")];
  const r = fillHolesFromPrevious(cur, [
    { position: 2, title: "Same" },        // two previous rows carry it
    { position: 3, title: "Never seen" },  // no match
    { position: 4, title: "C" },           // its URL is already in the take
  ], prev);
  assert.deepEqual(r.filled, []);
  assert.deepEqual(r.open, [2, 3, 4]);
  assert.equal(r.rows.length, 1);
});

test("no holes is a no-op", () => {
  const cur = [row(1, "a.gr", "A")];
  assert.deepEqual(fillHolesFromPrevious(cur, [], []), { rows: cur, filled: [], open: [] });
});
