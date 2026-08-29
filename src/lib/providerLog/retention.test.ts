// What the log throws away, and how carefully.
//
// Two windows, not one. Bodies are the expensive, sensitive half — prompts and completions in
// full — and they are worth keeping for about as long as anyone is still debugging the thing they
// were captured for. The row itself is cheap and is the record that the call happened at all, so
// it outlives its body by a wide margin. Clearing bodies first is what makes that difference
// real: a row that has lost its body still says a call was made, to whom, at what cost.
//
// The arithmetic gets a test of its own because a wrong sign here does not fail loudly — it
// deletes. A window of zero days would mean "everything up to this instant" and a negative one
// would reach into the future; both read as plausible input from a misconfigured setting, and
// both would empty the table on the next tick. They fall back to the default instead.
//
// The batching gets a test because the alternative is invisible in a unit test and obvious in
// production: one `deleteMany` over ninety days of rows holds a write lock for as long as it
// takes, against the per-call inserts this feature just added to every provider call in the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retentionCutoffs, sweepProviderLog, BODY_RETENTION_DAYS, ROW_RETENTION_DAYS,
  SWEEP_BATCH_SIZE, SWEEP_MAX_BATCHES, __setTableForTests,
} from "./retention";

const DAY = 86_400_000;
const NOW = new Date("2026-08-29T12:00:00.000Z");

/**
 * A table that answers like Prisma's does: `findMany` hands back at most `take` ids of rows that
 * still match, and the write that follows makes them stop matching. Without that second half the
 * sweep would re-select the same batch forever, which is a bug this fake can actually catch.
 */
function fakeTable(counts: { withBodies: number; expired: number }) {
  let withBodies = counts.withBodies;
  let expired = counts.expired;
  const ops: { op: string; phase: "bodies" | "rows"; n: number }[] = [];
  let seq = 0;
  const ids = (n: number) => Array.from({ length: n }, () => ({ id: `c${seq++}` }));
  return {
    ops,
    async findMany(args: any) {
      const bodies = Array.isArray(args?.where?.OR);
      const take = Number(args?.take);
      assert.ok(Number.isFinite(take) && take > 0, "every select must be bounded");
      const left = bodies ? withBodies : expired;
      return ids(Math.min(take, left));
    },
    async updateMany(args: any) {
      const n = args.where.id.in.length;
      ops.push({ op: "updateMany", phase: "bodies", n });
      withBodies -= n;
      return { count: n };
    },
    async deleteMany(args: any) {
      const n = args.where.id.in.length;
      ops.push({ op: "deleteMany", phase: "rows", n });
      expired -= n;
      return { count: n };
    },
  };
}

test("the two windows: bodies go early, the record of the call stays", () => {
  const { bodiesBefore, rowsBefore } = retentionCutoffs(NOW);
  assert.equal(bodiesBefore.getTime(), NOW.getTime() - BODY_RETENTION_DAYS * DAY);
  assert.equal(rowsBefore.getTime(), NOW.getTime() - ROW_RETENTION_DAYS * DAY);
  assert.ok(bodiesBefore > rowsBefore, "a body must be dropped long before the row that held it");
  assert.equal(BODY_RETENTION_DAYS, 7);
  assert.equal(ROW_RETENTION_DAYS, 90);
});

test("both windows can be overridden, independently", () => {
  const c = retentionCutoffs(NOW, { bodyDays: 1, rowDays: 30 });
  assert.equal(c.bodiesBefore.getTime(), NOW.getTime() - DAY);
  assert.equal(c.rowsBefore.getTime(), NOW.getTime() - 30 * DAY);
});

test("a zero, negative or nonsense window falls back to the default instead of emptying the table", () => {
  for (const bad of [0, -1, -365, NaN, Infinity, undefined as unknown as number]) {
    const c = retentionCutoffs(NOW, { bodyDays: bad, rowDays: bad });
    assert.equal(c.bodiesBefore.getTime(), NOW.getTime() - BODY_RETENTION_DAYS * DAY, `bodyDays=${bad}`);
    assert.equal(c.rowsBefore.getTime(), NOW.getTime() - ROW_RETENTION_DAYS * DAY, `rowDays=${bad}`);
    assert.ok(c.bodiesBefore < NOW, "a cutoff at or after `now` would take rows nobody meant to lose");
  }
});

test("bodies are cleared before any row is deleted", async () => {
  const table = fakeTable({ withBodies: 900, expired: 900 });
  __setTableForTests(table);
  try {
    const r = await sweepProviderLog(NOW);
    assert.deepEqual(r, { bodiesCleared: 900, rowsDeleted: 900 });
    const phases = table.ops.map(o => o.phase);
    assert.ok(phases.includes("bodies") && phases.includes("rows"), "both phases must have run");
    assert.ok(
      phases.lastIndexOf("bodies") < phases.indexOf("rows"),
      "a row must never be deleted while a body older than it is still on disk",
    );
  } finally { __setTableForTests(); }
});

test("the sweep is bounded: batch size and a ceiling per tick", async () => {
  const table = fakeTable({ withBodies: 100_000, expired: 100_000 });
  __setTableForTests(table);
  try {
    const r = await sweepProviderLog(NOW);
    const ceiling = SWEEP_BATCH_SIZE * SWEEP_MAX_BATCHES;
    assert.equal(r.bodiesCleared, ceiling);
    assert.equal(r.rowsDeleted, ceiling);
    assert.ok(table.ops.every(o => o.n <= SWEEP_BATCH_SIZE), "no single write may take more than a batch");
    for (const phase of ["bodies", "rows"] as const) {
      assert.equal(table.ops.filter(o => o.phase === phase).length, SWEEP_MAX_BATCHES);
    }
    assert.ok(ceiling < 100_000, "a ceiling that clears everything in one tick is not a ceiling");
  } finally { __setTableForTests(); }
});

test("nothing to sweep costs one probe per phase and writes nothing", async () => {
  const table = fakeTable({ withBodies: 0, expired: 0 });
  __setTableForTests(table);
  try {
    assert.deepEqual(await sweepProviderLog(NOW), { bodiesCleared: 0, rowsDeleted: 0 });
    assert.deepEqual(table.ops, []);
  } finally { __setTableForTests(); }
});

test("the cutoffs it sweeps by are the cutoffs it computed", async () => {
  const seen: any[] = [];
  __setTableForTests({
    findMany: async (args: any) => { seen.push(args.where); return []; },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  });
  try {
    await sweepProviderLog(NOW);
    const { bodiesBefore, rowsBefore } = retentionCutoffs(NOW);
    assert.equal(seen[0].at.lt.getTime(), bodiesBefore.getTime());
    assert.ok(Array.isArray(seen[0].OR), "the bodies pass must only look at rows that still have one");
    assert.equal(seen[1].at.lt.getTime(), rowsBefore.getTime());
  } finally { __setTableForTests(); }
});

test("a sweep that fails is a sweep that failed, not a scheduler that died", async () => {
  __setTableForTests({
    findMany: async () => { throw new Error("database is locked"); },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  });
  try {
    assert.deepEqual(await sweepProviderLog(NOW), { bodiesCleared: 0, rowsDeleted: 0 });
  } finally { __setTableForTests(); }
});

test("no table, no sweep — an instance that never ran db push is not an error", async () => {
  __setTableForTests(null);
  try {
    assert.deepEqual(await sweepProviderLog(NOW), { bodiesCleared: 0, rowsDeleted: 0 });
  } finally { __setTableForTests(); }
});
