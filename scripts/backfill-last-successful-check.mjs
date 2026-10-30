import "dotenv/config";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Production uses `prisma db push`, which creates the column but never runs the
// migration's UPDATE. Fill only missing values from successful historical checks.
// The null guard makes this safe on every deploy and preserves later writes.
export function backfillLastSuccessfulCheck(db) {
  return db.prepare(`
    UPDATE "TrackedKeyword"
    SET "lastSuccessfulCheckAt" = (
      SELECT MAX("checkedAt") FROM "RankCheck"
      WHERE "RankCheck"."keywordId" = "TrackedKeyword"."id"
        AND "RankCheck"."error" IS NULL
    )
    WHERE "lastSuccessfulCheckAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM "RankCheck"
        WHERE "RankCheck"."keywordId" = "TrackedKeyword"."id"
          AND "RankCheck"."error" IS NULL
      )
  `).run().changes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = process.env.DATABASE_URL || "";
  if (!raw.startsWith("file:")) {
    console.error("[rank-backfill] DATABASE_URL must be a SQLite file: URL");
    process.exitCode = 1;
  } else {
    const value = raw.slice("file:".length).split("?")[0];
    const dbPath = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
    let db;
    try {
      db = new Database(dbPath, { fileMustExist: true, timeout: 15000 });
      console.log(`[rank-backfill] filled ${backfillLastSuccessfulCheck(db)} keywords`);
    } catch (error) {
      console.error(`[rank-backfill] FAILED: ${error?.message ?? error}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
  }
}
