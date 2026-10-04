import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ledger against a scratch sqlite database, same setup as drops/availability.test.ts:
// DATABASE_URL must exist before ./prisma is imported, hence the dynamic imports and the
// single top-level test tree.

const dir = mkdtempSync(join(tmpdir(), "opengsc-magic-"));
let prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown>; $disconnect: () => Promise<void> };

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE MagicPurchase (
    id TEXT PRIMARY KEY, siteId TEXT, provider TEXT, orderId TEXT, taskId TEXT,
    query TEXT, targetUrl TEXT, anchor TEXT, language TEXT, quantity INTEGER,
    createdAt TIMESTAMP
  )`);
  const { recordPurchases } = await import("./purchases");
  void recordPurchases;
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("ledger: record, list per site, summarize per pair, fold one event per order", async () => {
  const { recordPurchases, listPurchases, summarize, purchaseOrderEvents, orderRecorded } = await import("./purchases");

  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId) VALUES ('site-1', 'u1'), ('site-2', 'u1')`);

  // One order, two briefs on site-1 (same pair bought 3+2) and one on site-2.
  await recordPurchases([
    { siteId: "site-1", targetUrl: "https://a.com/x", query: "bonus", language: "en", quantity: 3, taskId: "t1", orderId: "o1", provider: "fieldlink" },
    { siteId: "site-1", targetUrl: "https://a.com/x", query: "bonus", language: "en", quantity: 2, taskId: "t1", orderId: "o1", provider: "fieldlink" },
    { siteId: "site-2", targetUrl: "https://b.com/y", query: "freespins", language: "ru", quantity: 5, taskId: null, orderId: "o2", provider: "magic369" },
  ]);

  assert.equal((await listPurchases("site-1")).length, 2);
  assert.equal((await listPurchases("site-2")).length, 1);

  // The striking-distance mark: ONE summary per query+URL pair, quantities added up.
  const sums = summarize(await listPurchases("site-1"));
  assert.equal(sums.length, 1);
  assert.equal(sums[0].quantity, 5);
  assert.equal(sums[0].query, "bonus");

  // The chart marker: ONE event per order per site, on the EARLIEST row's UTC day.
  const events1 = await purchaseOrderEvents("site-1");
  assert.equal(events1.length, 1);
  assert.equal(events1[0].orderId, "o1");
  assert.equal(events1[0].quantity, 5);
  assert.equal(events1[0].provider, "fieldlink");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(events1[0].dayUtc));
  assert.deepEqual(events1[0].targetUrls, ["https://a.com/x"]);

  const events2 = await purchaseOrderEvents("site-2");
  assert.equal(events2.length, 1);
  assert.equal(events2[0].provider, "magic369");

  assert.equal(await orderRecorded("o1"), true);
  assert.equal(await orderRecorded("never"), false);
});

test("ledger: the lookback filter drops orders older than sinceIso", async () => {
  const { purchaseOrderEvents, recordPurchases } = await import("./purchases");
  await recordPurchases([
    { siteId: "site-1", targetUrl: "https://a.com/old", query: "old", language: "en", quantity: 1, taskId: null, orderId: "o-old", provider: "magic369" },
  ]);
  // Everything written in this test run is today; a sinceIso of tomorrow keeps none of it,
  // a sinceIso of yesterday keeps all of it.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  assert.equal((await purchaseOrderEvents("site-1", tomorrow)).length, 0);
  assert.ok((await purchaseOrderEvents("site-1", yesterday)).length >= 2);
});

test("ledger: zero-quantity rows never become summaries or markers", async () => {
  const { recordPurchases, summarize, purchaseOrderEvents, listPurchases } = await import("./purchases");
  await recordPurchases([
    { siteId: "site-2", targetUrl: "https://b.com/zero", query: "zero", language: "en", quantity: 0, taskId: null, orderId: "o-zero", provider: "fieldlink" },
  ]);
  assert.equal(summarize(await listPurchases("site-2")).find(s => s.query === "zero"), undefined);
  assert.equal((await purchaseOrderEvents("site-2")).find(e => e.orderId === "o-zero"), undefined);
});
