import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// redistributeQueue against a scratch sqlite database, same setup as toIndexer.test.ts:
// DATABASE_URL must exist before ../prisma is imported, hence the dynamic imports and the
// per-test awaits. The DDL mirrors the two models' scalar columns plus the domainId_url
// unique index the move (create-then-delete) semantics depend on.

const dir = mkdtempSync(join(tmpdir(), "opengsc-idxred-"));
type PrismaClientT = (typeof import("../prisma"))["prisma"];
let prisma: PrismaClientT;
let redistributeQueue: (typeof import("./redistribute"))["redistributeQueue"];

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  ({ redistributeQueue } = await import("./redistribute"));
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
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const mkDomain = (id: string, userId: string, domain: string, status = "active") =>
  prisma.indexerDomain.create({ data: { id, userId, domain, status, createdAt: new Date() } });

const mkRow = (
  id: string,
  domainId: string,
  url: string,
  over: { status?: string; crawledAt?: Date | null; createdAt?: Date } = {},
) =>
  prisma.indexerQueue.create({
    data: { id, domainId, url, createdAt: over.createdAt ?? new Date(), status: over.status ?? "pending", crawledAt: over.crawledAt ?? null },
  });

const rowsByDomain = async () => {
  const rows = await prisma.indexerQueue.findMany();
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = by.get(r.domainId);
    if (list) list.push(r);
    else by.set(r.domainId, [r]);
  }
  return by;
};

test("honest refusals: foreign user, foreign domain, empty queue, no other active doorway", async () => {
  const U = "u-err";
  await mkDomain("solo", U, "solo.example");

  assert.deepEqual(await redistributeQueue("someone-else"), { ok: false, reason: "no_indexer_domains" });
  assert.deepEqual(await redistributeQueue(U, { domainId: "nope" }), { ok: false, reason: "domain_not_found" });
  assert.deepEqual(await redistributeQueue(U), { ok: false, reason: "nothing_to_move" });

  // Rows exist but the only active doorway has nowhere to send them to.
  await mkRow("q-err-1", "solo", "https://x.example/1");
  assert.deepEqual(await redistributeQueue(U, { domainId: "solo" }), { ok: false, reason: "no_alternative_domains" });
});

test("domain scope: empties the doorway onto the others, evenly, as fresh pending rows", async () => {
  const U = "u-dom";
  await mkDomain("a1", U, "a1.example");
  await mkDomain("a2", U, "a2.example");
  await mkDomain("a3", U, "a3.example");
  const old = new Date(Date.now() - 86_400_000);
  for (let i = 0; i < 10; i++) {
    // Half already served to bots once — a dead doorway's rows must reset, not keep their state.
    await mkRow(`q-dom-${i}`, "a1", `https://x.example/${i}`, i % 2 === 0
      ? { status: "crawled", crawledAt: old }
      : { createdAt: new Date(Date.now() + i) });
  }

  const r = await redistributeQueue(U, { domainId: "a1" });
  assert.ok(r.ok);
  assert.equal(r.moved, 10);
  assert.equal(r.merged, 0);
  assert.equal(r.kept, 0);
  assert.equal(r.deduped, 0);
  assert.equal(r.domainsUsed, 2);

  const by = await rowsByDomain();
  assert.equal(by.get("a1")?.length ?? 0, 0, "source doorway must be empty");
  const a2 = by.get("a2")?.length ?? 0;
  const a3 = by.get("a3")?.length ?? 0;
  assert.equal(a2 + a3, 10);
  assert.ok(Math.abs(a2 - a3) <= 1, `even spread expected, got ${a2}/${a3}`);
  for (const rows of by.values()) {
    for (const row of rows) {
      assert.equal(row.status, "pending");
      assert.equal(row.crawledAt, null);
    }
  }
});

test("global scope: no url stays on its old doorway, spread stays even", async () => {
  const U = "u-glob";
  await mkDomain("b1", U, "b1.example");
  await mkDomain("b2", U, "b2.example");
  const before = new Map<string, string>(); // url → old domainId
  for (let i = 0; i < 6; i++) {
    await mkRow(`q-glob-b1-${i}`, "b1", `https://y.example/b1-${i}`, { createdAt: new Date(Date.now() + i) });
    before.set(`https://y.example/b1-${i}`, "b1");
  }
  for (let i = 0; i < 4; i++) {
    await mkRow(`q-glob-b2-${i}`, "b2", `https://y.example/b2-${i}`, { createdAt: new Date(Date.now() + 100 + i) });
    before.set(`https://y.example/b2-${i}`, "b2");
  }

  const r = await redistributeQueue(U);
  assert.ok(r.ok);
  assert.equal(r.moved, 10);
  assert.equal(r.domainsUsed, 2);

  const by = await rowsByDomain();
  const all = [...(by.get("b1") ?? []), ...(by.get("b2") ?? [])];
  assert.equal(all.length, 10);
  // With exactly two doorways the "never onto its own domain" rule makes this a swap: every
  // ex-b1 URL lands on b2 and vice versa, so the counts trade places (6/4 → 4/6).
  assert.equal(by.get("b1")?.length ?? 0, 4);
  assert.equal(by.get("b2")?.length ?? 0, 6);
  for (const row of all) {
    assert.notEqual(row.domainId, before.get(row.url), `${row.url} must have moved doorways`);
  }
});

test("merge: url already on the target keeps its existing row, source copy deleted", async () => {
  const U = "u-merge";
  await mkDomain("c1", U, "c1.example");
  await mkDomain("c2", U, "c2.example");
  const old = new Date(Date.now() - 3_600_000);
  await mkRow("q-m-1", "c1", "https://z.example/dup");
  await mkRow("q-m-2", "c2", "https://z.example/dup", { status: "crawled", crawledAt: old });

  const r = await redistributeQueue(U, { domainId: "c1" });
  assert.ok(r.ok);
  assert.equal(r.moved, 0);
  assert.equal(r.merged, 1);

  // Exactly one row survives — the one that was already on c2, with its own rotation state.
  const left = await prisma.indexerQueue.findMany({ where: { url: "https://z.example/dup" } });
  assert.equal(left.length, 1);
  assert.equal(left[0].domainId, "c2");
  assert.equal(left[0].id, "q-m-2");
});

test("dedupe: url on every active doorway collapses to one copy instead of vanishing", async () => {
  const U = "u-dedup";
  await mkDomain("d1", U, "d1.example");
  await mkDomain("d2", U, "d2.example");
  await mkRow("q-dd-1", "d1", "https://w.example/everywhere", { createdAt: new Date(Date.now() - 5_000) });
  await mkRow("q-dd-2", "d2", "https://w.example/everywhere");

  const r = await redistributeQueue(U);
  assert.ok(r.ok);
  assert.equal(r.moved, 0);
  assert.equal(r.kept, 1);
  assert.equal(r.deduped, 1);

  // The oldest copy is the survivor — the URL never leaves the queue entirely.
  const left = await prisma.indexerQueue.findMany({ where: { url: "https://w.example/everywhere" } });
  assert.equal(left.length, 1);
  assert.equal(left[0].id, "q-dd-1");
});

test("inactive doorways are never targets, but their rows still move", async () => {
  const U = "u-inact";
  await mkDomain("e1", U, "e1.example");
  await mkDomain("e2", U, "e2.example", "inactive");
  await mkDomain("e3", U, "e3.example");
  for (let i = 0; i < 4; i++) {
    await mkRow(`q-inact-${i}`, "e2", `https://v.example/${i}`, { createdAt: new Date(Date.now() + i) });
  }

  const r = await redistributeQueue(U);
  assert.ok(r.ok);
  assert.equal(r.moved, 4);
  assert.equal(r.domainsUsed, 2);

  const by = await rowsByDomain();
  assert.equal(by.get("e2")?.length ?? 0, 0, "the inactive doorway must be drained");
  assert.equal((by.get("e1")?.length ?? 0) + (by.get("e3")?.length ?? 0), 4);
});

test("single active doorway: its own rows stay kept, rows parked elsewhere drain onto it", async () => {
  const U = "u-solo";
  await mkDomain("f1", U, "f1.example");
  await mkDomain("f2", U, "f2.example", "inactive");
  await mkRow("q-solo-1", "f1", "https://s.example/on-active");
  await mkRow("q-solo-2", "f1", "https://s.example/on-active-2");
  await mkRow("q-solo-3", "f2", "https://s.example/on-inactive");

  const r = await redistributeQueue(U);
  assert.ok(r.ok);
  assert.equal(r.moved, 1);
  assert.equal(r.kept, 2);
  assert.equal(r.domainsUsed, 1);

  const by = await rowsByDomain();
  assert.equal(by.get("f2")?.length ?? 0, 0);
  assert.equal(by.get("f1")?.length, 3);
});
