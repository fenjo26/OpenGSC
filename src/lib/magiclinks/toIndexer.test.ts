import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// queuePurchasedDonors against a scratch sqlite database, same setup as tracking.test.ts:
// DATABASE_URL must exist before ../prisma is imported, hence the dynamic imports and the
// per-test awaits. The SiteBacklink DDL mirrors the model's scalar columns with the schema's
// defaults so prisma's create() works unchanged.

const dir = mkdtempSync(join(tmpdir(), "opengsc-mlidx-"));
// Type-only view of the dynamically imported client (DATABASE_URL must exist first at runtime).
type PrismaClientT = (typeof import("../prisma"))["prisma"];
let prisma: PrismaClientT;
let queuePurchasedDonors: (typeof import("./toIndexer"))["queuePurchasedDonors"];

const backlink = (id: string, over: Record<string, unknown>) => ({
  data: {
    id, siteId: "s1", urlFrom: `https://donor${id}.example/post`, urlFromNorm: `https://donor${id}.example/post`,
    urlTo: "https://money.example/", domainFrom: `donor${id}.example`,
    xrStatus: "", purchaseProvider: "fieldlink", purchaseOrderId: "o1",
    ...over,
  },
});

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  ({ queuePurchasedDonors } = await import("./toIndexer"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE MagicPurchase (
    id TEXT PRIMARY KEY, siteId TEXT, provider TEXT, orderId TEXT, taskId TEXT,
    query TEXT, targetUrl TEXT, anchor TEXT, language TEXT, quantity INTEGER,
    trackedAt TIMESTAMP, createdAt TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IndexerDomain (
    id TEXT PRIMARY KEY, userId TEXT, domain TEXT, status TEXT NOT NULL DEFAULT 'active',
    createdAt TIMESTAMP, apiKey TEXT, template TEXT, moneyUrl TEXT,
    allowedBots TEXT, pagesCount INTEGER, subdomainsCount INTEGER
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IndexerQueue (
    id TEXT PRIMARY KEY, domainId TEXT, url TEXT, status TEXT NOT NULL DEFAULT 'pending',
    createdAt TIMESTAMP, crawledAt TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX domainId_url ON IndexerQueue (domainId, url)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SiteBacklink (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, urlFrom TEXT NOT NULL, urlFromNorm TEXT NOT NULL,
    urlTo TEXT NOT NULL DEFAULT '', domainFrom TEXT NOT NULL DEFAULT '',
    apiSeen BOOLEAN NOT NULL DEFAULT 0, apiLost BOOLEAN NOT NULL DEFAULT 0, apiLostReason TEXT NOT NULL DEFAULT '',
    apiAnchor TEXT NOT NULL DEFAULT '', apiAlt TEXT NOT NULL DEFAULT '', apiDofollow BOOLEAN NOT NULL DEFAULT 1,
    apiNofollow BOOLEAN NOT NULL DEFAULT 0, apiSponsored BOOLEAN NOT NULL DEFAULT 0, apiUgc BOOLEAN NOT NULL DEFAULT 0,
    apiContent BOOLEAN NOT NULL DEFAULT 1, apiImage BOOLEAN NOT NULL DEFAULT 0, apiJsCrawl BOOLEAN NOT NULL DEFAULT 0,
    apiDr REAL, apiHttpCode INTEGER, apiLinkType TEXT NOT NULL DEFAULT '', apiSnippet TEXT NOT NULL DEFAULT '',
    apiFirstSeen TEXT NOT NULL DEFAULT '', apiLastSeen TEXT NOT NULL DEFAULT '', apiSpamScore INTEGER, apiFetchedAt TIMESTAMP,
    checkStatus TEXT NOT NULL DEFAULT 'unchecked', checkAnchor TEXT NOT NULL DEFAULT '', checkRel TEXT NOT NULL DEFAULT '',
    checkNofollow BOOLEAN NOT NULL DEFAULT 0, checkSponsored BOOLEAN NOT NULL DEFAULT 0, checkUgc BOOLEAN NOT NULL DEFAULT 0,
    checkFoundUrl TEXT NOT NULL DEFAULT '', checkMatchedDomain TEXT NOT NULL DEFAULT '', checkTargetOk BOOLEAN,
    checkError TEXT NOT NULL DEFAULT '', checkInsecure BOOLEAN NOT NULL DEFAULT 0, checkedAt TIMESTAMP,
    pageStatus TEXT NOT NULL DEFAULT 'unknown', pageTitle TEXT NOT NULL DEFAULT '', pageCheckedAt TIMESTAMP,
    xrStatus TEXT NOT NULL DEFAULT '', xrCheckedAt TIMESTAMP, twoIndexStatus TEXT NOT NULL DEFAULT '', twoIndexAt TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'api', sources TEXT NOT NULL DEFAULT '', favorite BOOLEAN NOT NULL DEFAULT 0,
    priceNote TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    purchaseProvider TEXT NOT NULL DEFAULT '', purchaseOrderId TEXT NOT NULL DEFAULT '',
    toxLevel TEXT NOT NULL DEFAULT 'unknown', toxScore INTEGER, toxSignals TEXT, toxCheckedAt TIMESTAMP,
    disavow BOOLEAN NOT NULL DEFAULT 0, disavowNote TEXT NOT NULL DEFAULT '',
    addedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX siteId_urlFromNorm_urlTo ON SiteBacklink (siteId, urlFromNorm, urlTo)`,
  );

  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId) VALUES ('s1', 'u1')`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO MagicPurchase (id, siteId, provider, orderId, quantity, createdAt)
     VALUES ('p1', 's1', 'fieldlink', 'o1', 3, CURRENT_TIMESTAMP),
            ('p2', 's1', 'fieldlink', 'o2', 1, CURRENT_TIMESTAMP),
            ('p3', 's2', 'fieldlink', 'oX', 1, CURRENT_TIMESTAMP)`,
  );
  // Three donors of o1: proved out of the index, never checked, proved indexed. Plus a foreign
  // user's purchased row that must never be visible to u1, and an o2 row for order scoping.
  await prisma.siteBacklink.create(backlink("b1", { xrStatus: "not_indexed" }));
  await prisma.siteBacklink.create(backlink("b2", {}));
  await prisma.siteBacklink.create(backlink("b3", { xrStatus: "indexed" }));
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId) VALUES ('s2', 'u2')`);
  await prisma.siteBacklink.create(backlink("b4", { siteId: "s2", purchaseOrderId: "oX", urlTo: "https://other.example/" }));
  await prisma.siteBacklink.create(backlink("b5", { purchaseOrderId: "o2" }));
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("no doorway domains → no_indexer_domains, nothing queued", async () => {
  const r = await queuePurchasedDonors("u1", { all: true });
  assert.deepEqual(r, { ok: false, reason: "no_indexer_domains" });
  assert.equal(await prisma.indexerDomain.count(), 0);
});

test("default mode is xr-gated: only proven not_indexed donors", async () => {
  await prisma.indexerDomain.create({ data: { id: "d1", userId: "u1", domain: "door1.example" } });
  const r = await queuePurchasedDonors("u1");
  assert.ok(r.ok);
  assert.equal(r.candidates, 1); // b1 only — b2 unchecked, b3 indexed, b4 foreign
  assert.equal(r.queued, 1);
  assert.equal(r.domains, 1);
  assert.equal(r.skippedIndexed, 1);
});

test("all=true covers never-checked donors too; re-run upserts without duplicating", async () => {
  const r = await queuePurchasedDonors("u1", { all: true });
  assert.ok(r.ok);
  assert.equal(r.candidates, 3); // b1 + b2 + b5 — b3 indexed, b4 foreign
  const r2 = await queuePurchasedDonors("u1", { all: true });
  assert.ok(r2.ok);
  assert.equal(r2.queued, 3); // upsert re-confirms the same rows
  const total = await prisma.indexerQueue.count();
  assert.equal(total, 3); // no duplicates after the second run
});

test("orderId scopes to one order and ignores ownership of others", async () => {
  const r = await queuePurchasedDonors("u1", { orderId: "o2" });
  assert.ok(r.ok);
  assert.equal(r.candidates, 1); // b5 only
  const foreign = await queuePurchasedDonors("u1", { orderId: "oX" });
  assert.deepEqual(foreign, { ok: false, reason: "order_not_found" }); // belongs to u2
  const unknown = await queuePurchasedDonors("u1", { orderId: "nope" });
  assert.deepEqual(unknown, { ok: false, reason: "order_not_found" });
});
