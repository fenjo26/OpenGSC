import { PrismaClient } from "../src/generated/prisma";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const rawUrl = process.env.DATABASE_URL || "file:./dev.db";
const url = rawUrl.replace(/^file:/, "");
const adapter = new PrismaBetterSqlite3({ url });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Starting IndexerLog rollup & migration...");

  // 1. Group all raw logs by domainId, date, botType, statusCode
  // Using robust date extraction that handles ISO strings, standard datetimes, and integer timestamps
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      domainId: string;
      date: string;
      botType: string;
      statusCode: number;
      cnt: number | bigint;
    }>
  >(`
    SELECT
      "domainId",
      CASE
        WHEN typeof("timestamp") = 'integer' THEN date("timestamp" / 1000, 'unixepoch')
        ELSE COALESCE(date("timestamp"), substr("timestamp", 1, 10))
      END AS date,
      "botType",
      "statusCode",
      COUNT(*) AS cnt
    FROM "IndexerLog"
    WHERE "domainId" IS NOT NULL AND "timestamp" IS NOT NULL
    GROUP BY "domainId", date, "botType", "statusCode"
  `);

  console.log(`Found ${rows.length} aggregated daily buckets from raw logs.`);

  let inserted = 0;

  for (const r of rows) {
    if (!r.domainId || !r.date || r.date.length < 10) continue;
    const count = Number(r.cnt);
    const code = Number(r.statusCode) || 200;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "IndexerDailyStat" ("id", "domainId", "date", "botType", "statusCode", "count")
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT("domainId", "date", "botType", "statusCode")
       DO UPDATE SET "count" = "count" + excluded."count"`,
      `stat_${r.domainId}_${r.date}_${r.botType}_${code}`,
      r.domainId,
      r.date,
      r.botType,
      code,
      count
    );
    inserted++;
  }

  console.log(`Successfully merged ${inserted} daily stat rows into IndexerDailyStat.`);

  // 2. Retention Cleanup: Keep the 5,000 most recent raw log entries only
  const deleteResult = await prisma.$executeRawUnsafe(`
    DELETE FROM "IndexerLog"
    WHERE "id" NOT IN (
      SELECT "id" FROM "IndexerLog" ORDER BY "timestamp" DESC LIMIT 5000
    )
  `);

  console.log(`Purged old raw log entries, keeping the latest 5,000 entries.`);

  // Vacuum SQLite database to recover disk space
  try {
    await prisma.$executeRawUnsafe(`VACUUM`);
    console.log("Database VACUUM completed successfully.");
  } catch (err) {
    console.log("VACUUM skipped/failed:", err);
  }

  console.log("Rollup complete!");
}

main()
  .catch((e) => {
    console.error("Migration error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
