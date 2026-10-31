import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// addPlacements against a scratch sqlite database, same setup as toIndexer.test.ts.
// This file exists because the real function used createMany({ skipDuplicates }) twice —
// an argument SQLite does not have, so every drops-activation enqueue threw
// "Unknown argument skipDuplicates" on the default dialect. The read-what-exists split
// (README §5) must keep the original semantics: idempotent re-runs, placement reactivation,
// and queue rows that already exist keep their crawledAt rotation state.

const dir = mkdtempSync(join(tmpdir(), "opengsc-dropsact-"));
type PrismaClientT = (typeof import("../prisma"))["prisma"];
let prisma: PrismaClientT;
let addPlacements: (typeof import("./activationStore"))["addPlacements"];

const U = "u-act";
const ASSET = "a1";
const DOORWAY_ID = "dw1";
const DOORWAY = "door.example";
const DONORS = [
  "https://donor1.example/post",
  "https://donor2.example/page",
  "https://donor3.example/article",
];

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  ({ addPlacements } = await import("./activationStore"));
  await prisma.$executeRawUnsafe(`CREATE TABLE DropAsset (
    id TEXT PRIMARY KEY, userId TEXT, domain TEXT, stage TEXT NOT NULL DEFAULT 'new',
    candidateId TEXT, gscSiteUrl TEXT, gscSitemapPath TEXT, gscSitemapSubmittedAt TIMESTAMP,
    sitemapUrl TEXT, sitemapBuiltAt TIMESTAMP, indexnowKey TEXT, indexnowPushedAt TIMESTAMP,
    indexnowCount INTEGER NOT NULL DEFAULT 0, indexnowLastStatus TEXT,
    lastGoogleHitAt TIMESTAMP, googleHits7d INTEGER NOT NULL DEFAULT 0,
    note TEXT, createdAt TIMESTAMP, updatedAt TIMESTAMP NOT NULL
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE DropDonorPlacement (
    id TEXT PRIMARY KEY, assetId TEXT, doorway TEXT, donorUrl TEXT,
    placedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, active BOOLEAN NOT NULL DEFAULT 1,
    lastVerifiedAt TIMESTAMP, verifyOk BOOLEAN
  )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX assetId_doorway_donorUrl
    ON DropDonorPlacement (assetId, doorway, donorUrl)`);
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
  await prisma.dropAsset.create({ data: { id: ASSET, userId: U, domain: "money.example" } });
  await prisma.indexerDomain.create({ data: { id: DOORWAY_ID, userId: U, domain: DOORWAY, createdAt: new Date() } });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("addPlacements works on SQLite (regression: createMany skipDuplicates threw here)", async () => {
  const r = await addPlacements(U, ASSET, DOORWAY, DONORS);
  assert.equal(r.added, 3);

  const placements = await prisma.dropDonorPlacement.findMany();
  assert.equal(placements.length, 3);
  assert.ok(placements.every(p => p.active === true));

  const queue = await prisma.indexerQueue.findMany();
  assert.equal(queue.length, 3);
  assert.ok(queue.every(q => q.domainId === DOORWAY_ID));
  assert.ok(queue.every(q => q.status === "pending"));
});

test("re-run is idempotent and never touches existing queue rows' rotation state", async () => {
  // Simulate one donor already served to bots: the re-run must not reset it.
  const old = new Date(Date.now() - 3_600_000);
  await prisma.indexerQueue.updateMany({
    where: { url: DONORS[0] },
    data: { status: "crawled", crawledAt: old },
  });

  const r = await addPlacements(U, ASSET, DOORWAY, DONORS);
  assert.equal(r.added, 0, "no new placements on a re-run");
  assert.equal((await prisma.dropDonorPlacement.findMany()).length, 3);
  assert.equal((await prisma.indexerQueue.findMany()).length, 3);

  const served = await prisma.indexerQueue.findFirst({ where: { url: DONORS[0] } });
  assert.equal(served?.status, "crawled");
  assert.equal(served?.crawledAt?.getTime(), old.getTime());
});

test("re-run reactivates a deactivated placement and refreshes placedAt", async () => {
  const before = await prisma.dropDonorPlacement.findFirst({ where: { donorUrl: DONORS[1] } });
  await new Promise(r => setTimeout(r, 25)); // placedAt refresh must be observable
  await prisma.dropDonorPlacement.updateMany({ where: { donorUrl: DONORS[1] }, data: { active: false } });

  const r = await addPlacements(U, ASSET, DOORWAY, DONORS);
  assert.equal(r.added, 0);

  const after = await prisma.dropDonorPlacement.findFirst({ where: { donorUrl: DONORS[1] } });
  assert.equal(after?.active, true);
  assert.ok(after!.placedAt.getTime() > before!.placedAt.getTime());
});

test("unknown doorway and foreign asset still refuse honestly", async () => {
  await assert.rejects(() => addPlacements(U, ASSET, "no-such.example", DONORS), /doorway_not_found/);
  await assert.rejects(() => addPlacements("someone-else", ASSET, DOORWAY, DONORS), /asset_not_found/);
  // A donor on the asset's own domain violates the footprint rule.
  await assert.rejects(
    () => addPlacements(U, ASSET, DOORWAY, ["https://money.example/self-link"]),
    /donor_not_allowed/,
  );
});
