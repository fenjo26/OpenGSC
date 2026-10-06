import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bootstrap proposals against a scratch sqlite database (the house setup). The DDLs are the
// minimal column sets the three raw queries touch — the queries are raw SQL precisely so a
// partial table (and a not-yet-migrated instance) answers zeros instead of crashing.

const dir = mkdtempSync(join(tmpdir(), "opengsc-ctxboot-"));
let prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown>; $disconnect: () => Promise<void> };

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT, url TEXT, aeoCompetitors TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE DailyMetric (
    id TEXT PRIMARY KEY, siteId TEXT, date DATETIME, url TEXT, query TEXT,
    searchType TEXT DEFAULT 'web', clicks INTEGER, impressions INTEGER, ctr REAL, position REAL
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE CompetitorKeyword (
    siteId TEXT, competitor TEXT, keyword TEXT, country TEXT DEFAULT 'us',
    position INTEGER, volume INTEGER, difficulty INTEGER, url TEXT DEFAULT '',
    source TEXT DEFAULT 'api', fetchedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (siteId, competitor, keyword, country)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SitemapUrl (id TEXT PRIMARY KEY, siteId TEXT, url TEXT)`);
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s1', 'u1', 'https://example.com/')`);
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("pure: inferKeyPageRole — root is the hub, everything else starts as other", async () => {
  const { inferKeyPageRole, contextIsEmpty } = await import("./bootstrap");
  assert.equal(inferKeyPageRole("/"), "hub");
  assert.equal(inferKeyPageRole("https://example.com"), "hub");
  assert.equal(inferKeyPageRole("https://example.com/"), "hub");
  assert.equal(inferKeyPageRole("/pricing"), "other");
  assert.equal(inferKeyPageRole("https://example.com/bonus"), "other");
  assert.equal(inferKeyPageRole("junk"), "other");

  assert.equal(contextIsEmpty({ sections: [], keyPages: [], competitors: [] }), true);
  assert.equal(contextIsEmpty({ sections: [{ key: "positioning", title: "", content: "  ", updatedBy: "user", updatedAt: "" }], keyPages: [], competitors: [] }), true, "blank content is still empty");
  assert.equal(contextIsEmpty({ sections: [], keyPages: [{ id: "1", url: "/x", role: "other", topic: "", notes: "", updatedBy: "user", updatedAt: "" }], competitors: [] }), false);
  assert.equal(contextIsEmpty({ sections: [], keyPages: [], competitors: [{ name: "R", domain: "r.com", terms: [] }] }), false);
});

test("bootstrap: top pages by clicks, rollup rows excluded, competitors by keyword overlap", async () => {
  const { bootstrapSuggestions } = await import("./bootstrap");
  const ins = async (url: string, clicks: number, daysAgo: number, searchType = "web") =>
    prisma.$executeRawUnsafe(
      `INSERT INTO DailyMetric (id, siteId, date, url, query, searchType, clicks, impressions, ctr, position)
       VALUES ('${Math.random().toString(36).slice(2)}', 's1', datetime('now', '-${daysAgo} days'), '${url}', 'q', '${searchType}', ${clicks}, ${clicks * 10}, 0.1, 5)`,
    );
  await ins("/", 500, 5);
  await ins("/bonus", 300, 10);
  await ins("/about", 50, 30);
  await ins("", 9999, 3);                      // rollup row — excluded
  await ins("/stale", 900, 200);               // outside the 90-day window
  await ins("/news-page", 800, 5, "news");     // non-web — excluded
  await prisma.$executeRawUnsafe(
    `INSERT INTO CompetitorKeyword (siteId, competitor, keyword, country) VALUES
     ('s1', 'rival-a.com', 'k1', 'us'), ('s1', 'rival-a.com', 'k2', 'us'), ('s1', 'rival-a.com', 'k1', 'gr'),
     ('s1', 'rival-b.com', 'k9', 'us')`,
  );
  for (let i = 0; i < 3; i++) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO SitemapUrl (id, siteId, url) VALUES ('sm${i}', 's1', 'https://example.com/p${i}')`,
    );
  }

  const boot = await bootstrapSuggestions("s1");
  assert.deepEqual(boot.suggestedKeyPages.map(p => p.url), ["/", "/bonus", "/about"]);
  assert.equal(boot.suggestedKeyPages[0].role, "hub");
  assert.equal(boot.suggestedKeyPages[1].role, "other");
  assert.equal(boot.suggestedKeyPages[0].clicks, 500);

  // DISTINCT keyword across countries: rival-a has k1+k2 = 2, not 3.
  assert.deepEqual(boot.suggestedCompetitors, [{ domain: "rival-a.com", keywords: 2 }, { domain: "rival-b.com", keywords: 1 }]);
  assert.equal(boot.sitemapUrls, 3);
});

test("bootstrap: a site with no synced data answers zeros, not an error", async () => {
  const { bootstrapSuggestions } = await import("./bootstrap");
  const boot = await bootstrapSuggestions("never-seen");
  assert.deepEqual(boot, { suggestedKeyPages: [], suggestedCompetitors: [], sitemapUrls: 0 });
});
