import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the pure selection logic is tested here: the tick itself is network-bound (donor fetches
// through runPlacementVerify) and is exercised by the placementRunner tests. The scratch DATABASE
// URL exists because importing the module transitively imports the prisma client.

const dir = mkdtempSync(join(tmpdir(), "opengsc-blverify-"));
let prisma: { $disconnect: () => Promise<void> };

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("pickStaleSites: never-checked first, then least recently checked, capped", async () => {
  const { pickStaleSites } = await import("./verifyScheduler");
  const now = Date.now();
  const picked = pickStaleSites([
    { siteId: "recent", oldest: new Date(now - 1 * 86_400_000), count: 10 },
    { siteId: "old", oldest: new Date(now - 10 * 86_400_000), count: 3 },
    { siteId: "never", oldest: null, count: 2 },
    { siteId: "mid", oldest: new Date(now - 5 * 86_400_000), count: 7 },
  ], 3);
  assert.deepEqual(picked.map(g => g.siteId), ["never", "old", "mid"]);
});

test("pickStaleSites: equal staleness falls back to the bigger backlog", async () => {
  const { pickStaleSites } = await import("./verifyScheduler");
  const t = new Date(0);
  const picked = pickStaleSites([
    { siteId: "small", oldest: t, count: 2 },
    { siteId: "big", oldest: t, count: 9 },
  ], 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].siteId, "big");
});

test("pickStaleSites: an empty map drains nothing", async () => {
  const { pickStaleSites } = await import("./verifyScheduler");
  assert.deepEqual(pickStaleSites([], 5), []);
});
