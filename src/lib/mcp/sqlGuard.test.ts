import assert from "node:assert/strict";
import { test } from "node:test";
// node:sqlite ships with every Node this repo supports (engines >=22.12) but its types only arrive with
// @types/node 22, and the repo pins 20 — hence the expect-error. The guard itself never imports it.
// @ts-expect-error -- no declaration for node:sqlite in @types/node 20
import { DatabaseSync } from "node:sqlite";
import { checkSqlitePlan, screenSqlText, stripSecretKeys, type SqliteLike } from "./sqlGuard";

function db(): SqliteLike & { exec(sql: string): void } {
  const d = new DatabaseSync(":memory:") as SqliteLike & { exec(sql: string): void };
  d.exec(`
    CREATE TABLE "Site" ("id" TEXT PRIMARY KEY, "url" TEXT, "userId" TEXT, "shareToken" TEXT, "clarityToken" TEXT);
    CREATE UNIQUE INDEX "Site_shareToken_key" ON "Site"("shareToken");
    CREATE INDEX "Site_userId_idx" ON "Site"("userId");
    CREATE TABLE "DailyMetric" ("id" TEXT PRIMARY KEY, "siteId" TEXT, "clicks" INTEGER, "promptTokens" INTEGER);
    CREATE TABLE "DropProxy" ("id" TEXT PRIMARY KEY, "host" TEXT, "password" TEXT);
    CREATE VIEW "SiteView" AS SELECT * FROM "Site";
    INSERT INTO "Site" VALUES ('s1','https://a.gr','u1','tok','ctok');
  `);
  return d;
}

// The guard runs the text screen first, then the plan; a query must pass both.
function verdict(sql: string): string | null {
  return screenSqlText(sql, "sqlite") ?? checkSqlitePlan(db(), sql);
}

test("ordinary analytics queries pass", () => {
  for (const q of [
    `SELECT "id", "url" FROM "Site"`,
    `SELECT s.url, SUM(m.clicks) AS c FROM "Site" s JOIN "DailyMetric" m ON m.siteId = s.id GROUP BY s.url`,
    `WITH x AS (SELECT id, url FROM Site) SELECT url FROM x`,
    `SELECT id FROM Site WHERE userId = 'u1'`,
    `SELECT name, sql FROM sqlite_master`,
    `SELECT promptTokens FROM DailyMetric`,
    `SELECT url FROM Site WHERE url LIKE '%token%'`,
  ]) assert.equal(verdict(q), null, q);
});

test("writes and admin statements are refused", () => {
  for (const q of [`DELETE FROM Site`, `SELECT 1; DROP TABLE Site`, `PRAGMA table_info(Site)`, `WITH x AS (SELECT 1) DELETE FROM Site`]) {
    assert.notEqual(verdict(q), null, q);
  }
});

test("secret tables are refused whether named or not", () => {
  assert.notEqual(screenSqlText(`SELECT host FROM DropProxy`, "sqlite"), null);
  assert.notEqual(screenSqlText(`SELECT * FROM "user"`, "sqlite"), null);
});

test("secret columns are refused when named", () => {
  assert.notEqual(verdict(`SELECT shareToken FROM Site`), null);
  assert.notEqual(verdict(`SELECT url FROM Site WHERE clarityToken IS NOT NULL`), null);
});

test("the plan check catches secrets the text never names", () => {
  const d = db();
  // Text passes; the plan must refuse.
  for (const q of [`SELECT * FROM Site`, `SELECT * FROM SiteView`, `SELECT x.* FROM (SELECT * FROM Site) x`]) {
    assert.equal(screenSqlText(q, "sqlite"), null, q);
    assert.notEqual(checkSqlitePlan(d, q), null, q);
  }
});

test("an index over a secret column is refused at open, even when no column of it is read", () => {
  const d = db();
  // Walks Site_shareToken_key (ordering rows by the secret) while reading only "id" from the table.
  const q = `SELECT id FROM Site INDEXED BY Site_shareToken_key`;
  assert.equal(screenSqlText(q, "sqlite"), null);
  assert.match(checkSqlitePlan(d, q) ?? "", /shareToken/);
  // The planner is free to pick a harmless index instead; that is not a leak and must pass.
  assert.equal(checkSqlitePlan(d, `SELECT id FROM Site INDEXED BY Site_userId_idx WHERE userId = 'u1'`), null);
});

test("MySQL screen refuses file and timing primitives", () => {
  for (const q of [`SELECT url FROM Site INTO OUTFILE '/tmp/x'`, `SELECT LOAD_FILE('/etc/hosts')`, `SELECT SLEEP(5)`, `SELECT * FROM mysql.user`, `SELECT id FROM Site FOR UPDATE`]) {
    assert.notEqual(screenSqlText(q, "mysql"), null, q);
  }
  assert.equal(screenSqlText(`SELECT url FROM Site`, "mysql"), null);
});

test("result keys that look like secrets are dropped", () => {
  assert.deepEqual(stripSecretKeys([{ id: 1, shareToken: "x", promptTokens: 3, apiKey: "k" }]), [{ id: 1, promptTokens: 3 }]);
});
