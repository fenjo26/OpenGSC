// Runs the three upsert behaviours against the database this instance is actually connected to,
// and prints pass/fail for each.
//
//   npx tsx scripts/verify-upsert-live.ts
//
// Why this exists next to check-upsert-sql.ts
// ------------------------------------------
// check-upsert-sql.ts asserts the *shape* of the generated statement without a database. It
// cannot tell you whether MySQL executes it the way the SQL says it should — and the only three
// behaviours worth porting (keep-on-null, reject-older, accumulate) are exactly the three that
// fail silently rather than loudly when a translation is wrong.
//
// Verifying them through the UI instead would need a Search Console site, keywords sitting in
// positions 11-20, and a paid Ahrefs or Semrush key: three things a person testing a database
// port has no reason to own. This needs a DATABASE_URL and nothing else.
//
// The specs below mirror the ones in src/lib/seo/metricsStore.ts. They are repeated rather than
// imported because writeKeywordCache and recordUsage swallow errors per row on purpose — a cache
// miss is recoverable in production, but here the database's own message is the entire point.
// If you change a mode or a guard there, change it here; check-upsert-sql.ts is what keeps the
// generated SQL honest, this is what keeps the server honest.
//
// Every row it writes uses reserved keys (see below) and is deleted again at the end, on both
// success and failure. It never touches real data.

// Loaded before anything that reads the environment. Next.js reads .env by itself, but a plain
// `tsx script.ts` does not — and src/lib/prisma.ts falls back to `file:./data/prod.db` when
// DATABASE_URL is unset. Without this, running the script from a MySQL install would test a
// SQLite file in the current directory and print PASS, which is the exact failure mode this
// script exists to catch.
import "dotenv/config";

import { runUpsert } from "../src/lib/db/upsert";
import { rawQuery, rawExec, currentDialect } from "../src/lib/db/raw";

const KEYWORD = "__opengsc_selftest__";
const COUNTRY = "zz";
const PROVIDER = "__selftest__";
const USER = "__opengsc_selftest__";
const MONTH = "1970-01";

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString();

let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures++;
}

/** One keyword-cache write, exactly as writeKeywordCache does it. */
async function writeKeyword(fields: {
  volume: number | null; difficulty: number | null; checkedAt: string; source: string;
}) {
  await runUpsert({
    table: "KeywordMetricCache",
    conflict: ["keyword", "country", "provider"],
    values: {
      keyword: KEYWORD, country: COUNTRY, provider: PROVIDER,
      volume: fields.volume, difficulty: fields.difficulty,
      cpc: null, globalVolume: null, parentTopic: null, intents: null, payload: null,
      source: fields.source, checkedAt: fields.checkedAt,
    },
    update: {
      volume: "keep", difficulty: "keep", cpc: "keep", globalVolume: "keep",
      parentTopic: "keep", intents: "keep", payload: "keep",
      source: "set", checkedAt: "set",
    },
    onlyIfNewer: "checkedAt",
  });
}

async function readKeyword() {
  const rows: any[] = await rawQuery(
    `SELECT volume, difficulty, source FROM "KeywordMetricCache"
      WHERE keyword = ? AND country = ? AND provider = ?`,
    KEYWORD, COUNTRY, PROVIDER,
  );
  return rows?.[0] ?? null;
}

/** One usage write, exactly as recordUsage does it. */
async function writeUsage(units: number) {
  await runUpsert({
    table: "ApiUsage",
    conflict: ["userId", "provider", "month"],
    values: { userId: USER, provider: PROVIDER, month: MONTH, units, requests: 1, updatedAt: iso(0) },
    update: { units: "add", requests: "add", updatedAt: "set" },
  });
}

async function readUsage() {
  const rows: any[] = await rawQuery(
    `SELECT units, requests FROM "ApiUsage" WHERE userId = ? AND provider = ? AND month = ?`,
    USER, PROVIDER, MONTH,
  );
  return rows?.[0] ?? null;
}

async function cleanup() {
  await rawExec(
    `DELETE FROM "KeywordMetricCache" WHERE keyword = ? AND country = ? AND provider = ?`,
    KEYWORD, COUNTRY, PROVIDER,
  ).catch(() => {});
  await rawExec(
    `DELETE FROM "ApiUsage" WHERE userId = ? AND provider = ? AND month = ?`,
    USER, PROVIDER, MONTH,
  ).catch(() => {});
}

/** The connection string with its password removed, so the output can be pasted into an issue. */
function safeUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

async function main() {
  // Refusing to guess. An unset DATABASE_URL would send every check to a SQLite file in the
  // current directory and pass, which reads as "MySQL works".
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "\nDATABASE_URL is not set, and guessing would make this script lie: it would test a " +
      "local SQLite file and report success.\n\nRun it from the directory holding your .env, " +
      "or pass the string explicitly:\n\n  DATABASE_URL='mysql://user:pass@host:3306/db' " +
      "npx tsx scripts/verify-upsert-live.ts\n",
    );
    process.exit(2);
  }

  const dialect = currentDialect();
  console.log(`\nDatabase: ${safeUrl(url)}\nDialect:  ${dialect}\n`);

  await cleanup();

  // ── 1. A null must not overwrite a stored value ─────────────────────────────
  //
  // The first write is a full row. The second is a *newer* partial one — a CSV with volumes but
  // no KD column — so the freshness guard lets it through and only COALESCE stands between the
  // stored difficulty and a null.
  console.log("1. keep — a null does not overwrite a known value");
  await writeKeyword({ volume: 1000, difficulty: 42, checkedAt: iso(-2), source: "api" });
  await writeKeyword({ volume: 1200, difficulty: null, checkedAt: iso(-1), source: "csv" });
  {
    const row = await readKeyword();
    check("difficulty survives a partial refresh", Number(row?.difficulty) === 42,
      `difficulty = ${row?.difficulty} (expected 42)`);
    check("volume still takes the new value", Number(row?.volume) === 1200,
      `volume = ${row?.volume} (expected 1200)`);
  }

  // ── 2. An older observation must lose ───────────────────────────────────────
  //
  // This is the one with no native MySQL equivalent, and the one where a wrong translation is
  // invisible: if `checkedAt` is assigned before the other columns, every guard after it compares
  // against the timestamp that was just written, passes, and the guard stops existing.
  console.log("\n2. onlyIfNewer — an older observation loses");
  await writeKeyword({ volume: 7, difficulty: 7, checkedAt: iso(-30), source: "csv" });
  {
    const row = await readKeyword();
    check("stale volume is rejected", Number(row?.volume) === 1200,
      `volume = ${row?.volume} (expected 1200, not 7)`);
    check("stale difficulty is rejected", Number(row?.difficulty) === 42,
      `difficulty = ${row?.difficulty} (expected 42, not 7)`);
    check("source is not rewritten by the rejected row", row?.source === "csv",
      `source = ${row?.source} (expected the value written in step 1)`);
  }

  // ── 3. Counters accumulate ─────────────────────────────────────────────────
  console.log("\n3. add — counters accumulate instead of replacing");
  await writeUsage(50);
  await writeUsage(50);
  {
    const row = await readUsage();
    check("units sum", Number(row?.units) === 100, `units = ${row?.units} (expected 100)`);
    check("requests sum", Number(row?.requests) === 2, `requests = ${row?.requests} (expected 2)`);
  }

  await cleanup();

  console.log(
    failures === 0
      ? `\nAll checks passed on ${dialect}.\n`
      : `\n${failures} check(s) failed on ${dialect}. The generated SQL is in scripts/check-upsert-sql.ts.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async err => {
  // A throw here is a result too: it means the database refused a statement outright rather than
  // executing it wrongly, and its message is more useful than anything this script could add.
  console.error("\nThe database rejected a statement:\n");
  console.error(err);
  await cleanup();
  process.exit(1);
});
