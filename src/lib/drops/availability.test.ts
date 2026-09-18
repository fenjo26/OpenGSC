import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitiseForUrl } from "./availability";

// The domain is concatenated into an RDAP endpoint, so this is the last line between a row in a
// user-supplied CSV and an outbound request to an address that row chose.
test("only LDH characters and dots survive into a URL", () => {
  assert.equal(sanitiseForUrl("Example.COM"), "example.com");
  assert.equal(sanitiseForUrl("  example.com  "), "example.com");
  assert.equal(sanitiseForUrl("example.com/../../admin"), "example.com....admin");
  assert.equal(sanitiseForUrl("example.com?x=1"), "example.comx1");
  assert.equal(sanitiseForUrl("evil.com@internal.host"), "evil.cominternal.host");
  assert.equal(sanitiseForUrl("a b.com"), "ab.com");
  assert.equal(sanitiseForUrl("http://example.com"), "httpexample.com");
});

test("a sanitised value never contains a path, query, fragment or authority separator", () => {
  for (const nasty of ["a/b.com", "a?b.com", "a#b.com", "a@b.com", "a:b.com", "a\\b.com", "a%2f.com"]) {
    const clean = sanitiseForUrl(nasty);
    for (const ch of ["/", "?", "#", "@", ":", "\\", "%"]) {
      assert.ok(!clean.includes(ch), `${nasty} -> ${clean} still contains ${ch}`);
    }
  }
});

// ── recordAvailabilityResults returns rows WRITTEN, not verdicts received ─────
//
// The 8/19-vs-2/25 desync: the progress panels read these counters while the table reads
// the persisted stage, and a verdict for a domain that is not in the catalogue used to be
// counted anyway (see docs/tasks/drops-activation/T1-verdict-desync.md). Scratch SQLite
// database, the same trick prisma.test.ts uses — DATABASE_URL must be set before ./store
// (→ ./prisma) is imported, hence the dynamic imports inside the test.
test("phantom verdicts are not counted, real rows are", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opengsc-drops-avail-"));
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  const { prisma } = await import("../prisma");
  const { recordAvailabilityResults } = await import("./store");

  const userId = "user-t1";
  await prisma.$executeRawUnsafe(`CREATE TABLE DropCandidate (
    id TEXT PRIMARY KEY, userId TEXT, domain TEXT, tld TEXT, stage TEXT DEFAULT 'ingested',
    lastStatus TEXT, lastHttp INTEGER, lastVia TEXT, lastError TEXT,
    consecutiveErrors INTEGER DEFAULT 0, corroborated BOOLEAN DEFAULT 0,
    lastCheckedAt DATETIME, nextCheckAt DATETIME,
    registryExpiresAt DATETIME, registryCreatedAt DATETIME, registryStatus TEXT, nameServers TEXT,
    updatedAt DATETIME
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE DropEvent (
    id TEXT PRIMARY KEY, candidateId TEXT, type TEXT, message TEXT, createdAt DATETIME
  )`);
  // One row in the catalogue; the other two domains exist only in the verdict batch.
  await prisma.$executeRawUnsafe(
    `INSERT INTO DropCandidate (id, userId, domain, tld, stage) VALUES ('c1', '${userId}', 'in-catalogue.gr', 'gr', 'dns_checked')`,
  );

  const results = new Map<string, import("./types").AvailabilityResult>([
    ["in-catalogue.gr", { ok: true, status: "available", http: 404, via: "rdap", corroborated: true }],
    ["phantom-free.gr", { ok: true, status: "available", http: 404, via: "rdap", corroborated: true }],
    ["phantom-taken.gr", { ok: true, status: "registered", http: 200, via: "rdap" }],
    ["phantom-refused.gr", { ok: false, status: "rate_limited", http: 429 }],
  ]);

  const written = await recordAvailabilityResults(userId, results);

  // Only the catalogue row counts — the panels can no longer diverge from the table on it.
  assert.deepEqual(
    { available: written.available, taken: written.taken, deferred: written.deferred, decided: written.decided },
    { available: 1, taken: 0, deferred: 0, decided: 1 },
  );

  const row = (await prisma.$queryRawUnsafe<{ stage: string; corroborated: number }[]>(
    `SELECT stage, corroborated FROM DropCandidate WHERE domain = 'in-catalogue.gr'`,
  ))[0];
  assert.equal(row.stage, "available");
  assert.ok(row.corroborated, "corroborated persisted as true");

  await prisma.$disconnect();
});
