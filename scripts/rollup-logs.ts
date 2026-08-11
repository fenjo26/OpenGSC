import { PrismaClient } from "../src/generated/prisma";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const rawUrl = process.env.DATABASE_URL || "file:./dev.db";
const url = rawUrl.replace(/^file:/, "");
const adapter = new PrismaBetterSqlite3({ url });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Starting IndexerLog rollup & migration...");

  // 1. Group all raw logs by domainId, date, botType, statusCode
  // Using raw SQL because formatting date is much faster in SQLite batch
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
      strftime('%Y-%m-%d', CASE WHEN typeof("timestamp") = 'integer' THEN "timestamp" / 1000 ELSE strftime('%s', "timestamp") END, 'unixepoch') AS date,
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
    if (!r.domainId || !r.date) continue;
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

  // 2. Retention Cleanup: Keep raw logs from the last 7 days only
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  const deleteResult = await prisma.indexerLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoff,
      },
    },
  });

  console.log(`Purged ${deleteResult.count} old raw log entries older than 7 days.`);

  // Vacuum SQLite database to recover disk space if needed
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
