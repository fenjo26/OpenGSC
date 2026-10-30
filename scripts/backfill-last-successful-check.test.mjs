import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { backfillLastSuccessfulCheck } from "./backfill-last-successful-check.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

test("deploy backfill fills only missing successful check times and is repeatable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rank-backfill-"));
  const dbPath = path.join(dir, "test.db");
  try {
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE "TrackedKeyword" ("id" TEXT PRIMARY KEY, "lastSuccessfulCheckAt" DATETIME);
        CREATE TABLE "RankCheck" ("keywordId" TEXT, "checkedAt" DATETIME, "error" TEXT);
        INSERT INTO "TrackedKeyword" VALUES ('found', NULL), ('failed', NULL), ('existing', 777), ('unseen', NULL);
        INSERT INTO "RankCheck" VALUES
          ('found', 100, NULL), ('found', 300, 'empty_serp'), ('found', 200, NULL),
          ('failed', 400, 'quota'), ('existing', 500, NULL);
      `);
      assert.equal(backfillLastSuccessfulCheck(db), 1);
      assert.equal(backfillLastSuccessfulCheck(db), 0);
      assert.deepEqual(db.prepare('SELECT "id", "lastSuccessfulCheckAt" FROM "TrackedKeyword" ORDER BY "id"').all(), [
        { id: "existing", lastSuccessfulCheckAt: 777 },
        { id: "failed", lastSuccessfulCheckAt: null },
        { id: "found", lastSuccessfulCheckAt: 200 },
        { id: "unseen", lastSuccessfulCheckAt: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
