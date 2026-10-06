import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Purchased-placement tracking against a scratch sqlite database, same setup as
// purchases.test.ts: DATABASE_URL must exist before ../prisma is imported, hence the dynamic
// imports and the per-test awaits. The SiteBacklink DDL mirrors the model's scalar columns with
// the schema's defaults so prisma's create() works unchanged.

const dir = mkdtempSync(join(tmpdir(), "opengsc-mltrack-"));
let prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown>; $disconnect: () => Promise<void> };

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE MagicPurchase (
    id TEXT PRIMARY KEY, siteId TEXT, provider TEXT, orderId TEXT, taskId TEXT,
    query TEXT, targetUrl TEXT, anchor TEXT, language TEXT, quantity INTEGER,
    trackedAt TIMESTAMP, createdAt TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SiteBacklink (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, urlFrom TEXT NOT NULL, urlFromNorm TEXT NOT NULL,
    urlTo TEXT NOT NULL DEFAULT '', domainFrom TEXT NOT NULL DEFAULT '',
    apiSeen BOOLEAN NOT NULL DEFAULT 0, apiLost BOOLEAN NOT NULL DEFAULT 0, apiLostReason TEXT NOT NULL DEFAULT '',
    apiAnchor TEXT NOT NULL DEFAULT '', apiAlt TEXT NOT NULL DEFAULT '', apiDofollow BOOLEAN NOT NULL DEFAULT 1,
    apiNofollow BOOLEAN NOT NULL DEFAULT 0, apiSponsored BOOLEAN NOT NULL DEFAULT 0, apiUgc BOOLEAN NOT NULL DEFAULT 0,
    apiContent BOOLEAN NOT NULL DEFAULT 1, apiImage BOOLEAN NOT NULL DEFAULT 0, apiJsCrawl BOOLEAN NOT NULL DEFAULT 0,
    apiDr REAL, apiHttpCode INTEGER, apiLinkType TEXT NOT NULL DEFAULT '', apiSnippet TEXT NOT NULL DEFAULT '',
    apiFirstSeen TEXT NOT NULL DEFAULT '', apiLastSeen TEXT NOT NULL DEFAULT '', apiFetchedAt TIMESTAMP,
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
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("pure: placements from provider payloads", async () => {
  const {
    placementsFromFieldLink, placementsFromMagic369,
    isFieldLinkTerminal, isMagic369Terminal, mergeSources,
  } = await import("./tracking");

  // FieldLink: a row contributes only when BOTH the destination and the target exist — a
  // processing row is money in flight, not a placement.
  const rows: unknown[] = [
    { id: "1", status: "completed", input: { targetUrl: "https://me.com/page", anchor: "a", language: "en" }, result: { destination: "https://donor.com/post-1" } },
    { id: "2", status: "processing", input: { targetUrl: "https://me.com/page", anchor: "a", language: "en" }, result: null },
    { id: "3", status: "completed", input: { targetUrl: "", anchor: "a", language: "en" }, result: { destination: "https://donor.com/post-3" } },
  ];
  assert.deepEqual(placementsFromFieldLink(rows as never), [
    { donorUrl: "https://donor.com/post-1", targetUrl: "https://me.com/page" },
  ]);

  // 369Team: the articles list IS the placement list.
  const articles: unknown[] = [
    { id: 1, url: "https://me.com/page", anchor: "a", title: "", publishedUrl: "https://donor.com/art-1", publishedAt: null },
    { id: 2, url: "https://me.com/page", anchor: "a", title: "", publishedUrl: "", publishedAt: null },
  ];
  assert.deepEqual(placementsFromMagic369(articles as never), [
    { donorUrl: "https://donor.com/art-1", targetUrl: "https://me.com/page" },
  ]);

  assert.equal(isFieldLinkTerminal("completed"), true);
  assert.equal(isFieldLinkTerminal("partial"), true);
  assert.equal(isFieldLinkTerminal("failed"), true);
  assert.equal(isFieldLinkTerminal("processing"), false);
  assert.equal(isMagic369Terminal({ status: "processing" }), false);
  assert.equal(isMagic369Terminal({ status: "processing", finalizedAt: "2026-10-01" }), true);
  assert.equal(isMagic369Terminal({ status: "completed" }), true);

  assert.equal(mergeSources("", "purchase"), "purchase");
  assert.equal(mergeSources("api", "purchase"), "api,purchase");
  assert.equal(mergeSources("api,purchase", "purchase"), "api,purchase");
  assert.equal(mergeSources("api, csv ", "purchase"), "api,csv,purchase");
});

test("pure: foldPulse keeps unconfirmed apart from gone", async () => {
  const { foldPulse } = await import("./tracking");
  const pulse = foldPulse([
    { purchaseProvider: "fieldlink", checkStatus: "found", checkedAt: new Date("2026-10-01T10:00:00Z") },
    { purchaseProvider: "fieldlink", checkStatus: "found", checkedAt: new Date("2026-10-02T10:00:00Z") },
    { purchaseProvider: "fieldlink", checkStatus: "missing", checkedAt: new Date("2026-10-03T10:00:00Z") },
    { purchaseProvider: "fieldlink", checkStatus: "blocked", checkedAt: null },
    { purchaseProvider: "fieldlink", checkStatus: "unchecked", checkedAt: null },
    { purchaseProvider: "", checkStatus: "found", checkedAt: new Date() }, // not purchased — ignored
    { purchaseProvider: "magic369", checkStatus: "found", checkedAt: new Date("2026-09-01T10:00:00Z") },
  ]);
  assert.equal(pulse.length, 2);
  const fl = pulse[0];
  assert.equal(fl.provider, "fieldlink");
  assert.equal(fl.name, "FieldLink");
  assert.equal(fl.placements, 5);
  assert.equal(fl.found, 2);
  assert.equal(fl.missing, 1);
  assert.equal(fl.blocked, 1);
  assert.equal(fl.unchecked, 1);
  assert.equal(fl.lastCheckedAt, "2026-10-03T10:00:00.000Z");
  assert.equal(pulse[1].provider, "magic369");
});

test("db: import creates, claims and dedupes placements", async () => {
  const { importPurchasedPlacements } = await import("./tracking");
  const { prisma: p } = await import("../prisma");
  await p.$executeRawUnsafe(`INSERT INTO Site (id, userId) VALUES ('site-1', 'u1')`);

  const r1 = await importPurchasedPlacements({
    siteId: "site-1", provider: "fieldlink", orderId: "o1",
    placements: [
      { donorUrl: "https://Donor.com/Post-1/", targetUrl: "https://me.com/page" },
      { donorUrl: "https://donor.com/post-1", targetUrl: "https://me.com/page" }, // same pair post-normalization
      { donorUrl: "", targetUrl: "https://me.com/page" },                        // no donor — skipped
      { donorUrl: "https://me.com/self", targetUrl: "https://me.com/self" },     // donor = target — skipped
    ],
  });
  assert.equal(r1.imported, 1);
  assert.equal(r1.updated, 0);
  // The duplicate pair is deduped before it counts anywhere; blank donor and self-link are skipped.
  assert.equal(r1.skipped, 2);

  const row = await p.siteBacklink.findFirst({ where: { siteId: "site-1" } });
  assert.equal(row?.urlFromNorm, "donor.com/post-1");
  assert.equal(row?.urlFrom, "https://Donor.com/Post-1/"); // kept exactly as it arrived
  assert.equal(row?.domainFrom, "donor.com");
  assert.equal(row?.source, "purchase");
  assert.equal(row?.purchaseProvider, "fieldlink");
  assert.equal(row?.purchaseOrderId, "o1");

  // A row the api writer created first keeps its identity; the import only claims provenance
  // (CONTRACT.md §1: one row, several writers, each names only its own group).
  await p.siteBacklink.create({
    data: {
      siteId: "site-1", urlFrom: "https://api-donor.com/x", urlFromNorm: "api-donor.com/x",
      urlTo: "https://me.com/page", domainFrom: "api-donor.com", source: "api", sources: "api",
      checkStatus: "found", checkAnchor: "kept",
    },
  });
  const r2 = await importPurchasedPlacements({
    siteId: "site-1", provider: "magic369", orderId: "o2",
    placements: [{ donorUrl: "https://api-donor.com/x", targetUrl: "https://me.com/page" }],
  });
  assert.equal(r2.imported, 0);
  assert.equal(r2.updated, 1);
  const claimed = await p.siteBacklink.findFirst({ where: { urlFromNorm: "api-donor.com/x" } });
  assert.equal(claimed?.source, "api");            // creator unchanged
  assert.equal(claimed?.sources, "api,purchase");  // provenance appended, not overwritten
  assert.equal(claimed?.checkAnchor, "kept");      // the check* group is not the import's to touch
  assert.equal(claimed?.purchaseProvider, "magic369");
  assert.equal(claimed?.purchaseOrderId, "o2");
});

test("db: the ledger knows which orders still owe placements", async () => {
  const { untrackedOrders, markOrderTracked, orderOwner } = await import("./tracking");
  const { recordPurchases } = await import("./purchases");
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId) VALUES ('site-led', 'u1')`); // no-op if re-run

  await recordPurchases([
    { siteId: "site-led", targetUrl: "https://me.com/a", query: "q1", language: "en", quantity: 2, taskId: "t1", orderId: "ord-1", provider: "fieldlink" },
    { siteId: "site-led", targetUrl: "https://me.com/b", query: "q2", language: "en", quantity: 1, taskId: null, orderId: "ord-2", provider: "magic369" },
  ]);

  // Fresh rows sit inside the 2-hour grace window: nothing to poll yet.
  assert.equal((await untrackedOrders(10)).length, 0);

  // Age one order past the window; it becomes pending, once, with its owner resolved.
  await prisma.$executeRawUnsafe(`UPDATE MagicPurchase SET createdAt = datetime('now', '-3 hours') WHERE orderId = 'ord-1'`);
  const pending = await untrackedOrders(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderId, "ord-1");
  assert.equal(pending[0].provider, "fieldlink");
  assert.equal(pending[0].userId, "u1");
  assert.equal(pending[0].siteId, "site-led");

  const owner = await orderOwner("ord-1");
  assert.equal(owner?.siteId, "site-led");
  assert.equal(owner?.trackedAt, null);
  assert.equal(await orderOwner("not-ours"), null);

  // Tracked orders leave the queue and stay out.
  await markOrderTracked("fieldlink", "ord-1");
  assert.equal((await untrackedOrders(10)).length, 0);
  assert.ok((await orderOwner("ord-1"))?.trackedAt);

  // Beyond 45 days an order is forgotten even if it was never tracked — nobody is coming.
  await prisma.$executeRawUnsafe(
    `UPDATE MagicPurchase SET trackedAt = NULL, createdAt = datetime('now', '-50 days') WHERE orderId = 'ord-1'`,
  );
  assert.equal((await untrackedOrders(10)).length, 0);
});
