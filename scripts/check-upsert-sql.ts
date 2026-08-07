// Prints the statement `buildUpsert` generates for every upsert in the app, so it can be read
// against the hand-written SQL it replaced.
//
// This is a diff aid, not a test suite. The whole risk of routing 15 hand-written upserts
// through one builder is a generated statement that is subtly not the one it replaced — a
// dropped COALESCE, a missing freshness guard — and none of that surfaces as a type error or a
// crash. It surfaces months later as a cached number that should not have been overwritten.
//
//   npx tsx scripts/check-upsert-sql.ts
//
// Only `buildUpsert` is called, so nothing is written and no query runs. It does construct a
// Prisma client — an incidental side effect of importing the builder, which shares a module with
// the function that runs the statement — but no query is ever sent, so on SQLite the construction
// is free and the run prints one line of client debug output before the first case.
//
// On MySQL that side effect bites if the environment is not loaded. `tsx` does not read .env the
// way Next.js does, so without the import below DATABASE_URL is unseen, the client defaults to the
// SQLite adapter, and the generated client (built for the mysql provider by prisma.config.ts)
// rejects it: "Driver Adapter ... is not compatible with the provider 'mysql'". Loading dotenv
// makes the adapter match the client, and since no query runs nothing connects. Same reason
// verify-upsert-live.ts loads it first, and the same fix for the same trap.

import "dotenv/config";
import { buildUpsert, type SqlDialect, type UpsertSpec } from "../src/lib/db/upsert";

const CASES: { name: string; spec: UpsertSpec }[] = [
  {
    name: "KeywordMetricCache — writeKeywordCache",
    spec: {
      table: "KeywordMetricCache",
      conflict: ["keyword", "country", "provider"],
      values: {
        keyword: "", country: "", provider: "", volume: null, difficulty: null, cpc: null,
        globalVolume: null, parentTopic: null, intents: null, payload: null,
        source: "", checkedAt: "",
      },
      update: {
        volume: "keep", difficulty: "keep", cpc: "keep", globalVolume: "keep",
        parentTopic: "keep", intents: "keep", payload: "keep",
        source: "set", checkedAt: "set",
      },
      onlyIfNewer: "checkedAt",
    },
  },
  {
    name: "DomainMetricCache — writeDomainCache",
    spec: {
      table: "DomainMetricCache",
      conflict: ["domain", "provider"],
      values: {
        domain: "", provider: "", dr: null, refDomains: null, backlinks: null,
        orgTraffic: null, orgKeywords: null, orgCost: null, payload: null, source: "", checkedAt: "",
      },
      update: {
        dr: "keep", refDomains: "keep", backlinks: "keep",
        orgTraffic: "keep", orgKeywords: "keep", orgCost: "keep", payload: "keep",
        source: "set", checkedAt: "set",
      },
      onlyIfNewer: "checkedAt",
    },
  },
  {
    name: "ApiUsage — recordUsage",
    spec: {
      table: "ApiUsage",
      conflict: ["userId", "provider", "month"],
      values: { userId: "", provider: "", month: "", units: 0, requests: 1, updatedAt: "" },
      update: { units: "add", requests: "add", updatedAt: "set" },
    },
  },
  {
    name: "RefDomainRow — syncRefDomains",
    spec: {
      table: "RefDomainRow",
      conflict: ["target", "refDomain", "provider"],
      values: {
        target: "", refDomain: "", provider: "", dr: null, linksToTarget: null,
        dofollow: 1, firstSeen: "", lost: 0, lostAt: "", source: "", fetchedAt: "",
      },
      update: {
        dr: "keep", linksToTarget: "keep", dofollow: "set", firstSeen: "keepEmpty",
        lost: "set", lostAt: "set", source: "set", fetchedAt: "set",
      },
    },
  },
  {
    name: "BacklinkSnapshot — writeSnapshot",
    spec: {
      table: "BacklinkSnapshot",
      conflict: ["target", "date", "provider"],
      values: {
        target: "", date: "", provider: "", refDomains: null, backlinks: null,
        dofollowPct: null, source: "", createdAt: "",
      },
      update: { refDomains: "keep", backlinks: "keep", dofollowPct: "keep", source: "set" },
    },
  },
  {
    name: "CompetitorKeyword — /api/metrics/gap",
    spec: {
      table: "CompetitorKeyword",
      conflict: ["siteId", "competitor", "keyword", "country"],
      values: {
        siteId: "", competitor: "", keyword: "", country: "", position: null, volume: null,
        difficulty: null, url: "", source: "api", fetchedAt: "",
      },
      update: { position: "set", volume: "set", difficulty: "keep", url: "set", fetchedAt: "set" },
    },
  },
  {
    name: "DrCache — /api/dr",
    spec: {
      table: "DrCache",
      conflict: ["domain"],
      values: { domain: "", dr: 0, checkedAt: "" },
      update: { dr: "set", checkedAt: "set" },
    },
  },
  {
    name: "EnginePortfolioCache — /api/gsc/portfolio-engine",
    spec: {
      table: "EnginePortfolioCache",
      conflict: ["userId", "engine", "period"],
      values: { id: "", userId: "", engine: "", period: "", data: "", updatedAt: "" },
      update: { data: "set", updatedAt: "set" },
    },
  },
  {
    name: "SeoHistory — /api/seo/history",
    spec: {
      table: "SeoHistory",
      conflict: ["id"],
      values: {
        id: "", userId: "", type: "", keyword: "", status: "", data: "", meta: null,
        createdAt: "", updatedAt: "",
      },
      update: { data: "set", meta: "set", status: "set", keyword: "set", updatedAt: "set" },
    },
  },
  {
    name: "KeywordVolumeHistory — /api/metrics/demand",
    spec: {
      table: "KeywordVolumeHistory",
      conflict: ["keyword", "country", "provider"],
      values: { keyword: "", country: "", provider: "", points: "", fetchedAt: "" },
      update: { points: "set", fetchedAt: "set" },
    },
  },
  {
    name: "DemandSearch — keyword search cache",
    spec: {
      table: "DemandSearch",
      conflict: ["userId", "cacheKey"],
      values: {
        userId: "", cacheKey: "", seed: "", country: "", language: "", mode: "", source: "",
        rows: "", createdAt: "",
      },
      update: { source: "set", rows: "set", createdAt: "set" },
    },
  },
];

/**
 * The three behaviours that can break on a dialect switch, asserted per dialect.
 *
 * These are not stylistic checks. Each one corresponds to a way the data goes quietly wrong:
 * a dropped COALESCE erases values someone paid for, a missing guard lets a stale CSV import
 * overwrite fresh API data, and a lost accumulator silently resets the spend counter.
 */
function problemsFor(spec: UpsertSpec, sql: string, params: unknown[], dialect: SqlDialect): string[] {
  const problems: string[] = [];
  const cols = Object.keys(spec.values).length;

  if (params.length !== cols) problems.push(`params ${params.length} != columns ${cols}`);
  if ((sql.match(/\?/g) ?? []).length !== cols) problems.push("placeholder count != column count");

  const incoming = (c: string) => (dialect === "mysql" ? `VALUES(\`${c}\`)` : `excluded."${c}"`);
  const stored = (c: string) => (dialect === "mysql" ? `\`${c}\`` : `"${spec.table}"."${c}"`);

  for (const [col, mode] of Object.entries(spec.update)) {
    if (mode === "keep" && !sql.includes(`COALESCE(${incoming(col)}`)) {
      problems.push(`${col}: COALESCE missing`);
    }
    if (mode === "add" && !sql.includes(`${stored(col)} + ${incoming(col)}`)) {
      problems.push(`${col}: not accumulating`);
    }
  }

  const guard = spec.onlyIfNewer;
  if (guard) {
    if (dialect === "mysql") {
      // MySQL has no conditional on-duplicate clause, so the guard must appear on every
      // assignment rather than once at the end.
      const wrapped = (sql.match(/IF\(/g) ?? []).length;
      const expected = Object.keys(spec.update).length;
      if (wrapped !== expected) problems.push(`guard on ${wrapped}/${expected} assignments`);

      // And the guarded column has to be written last, or the assignments after it would
      // compare against the value it just wrote instead of the stored one.
      const assignOrder = [...sql.matchAll(/`(\w+)` = IF\(/g)].map(m => m[1]);
      if (assignOrder[assignOrder.length - 1] !== guard) {
        problems.push(`guard column "${guard}" is not assigned last (order: ${assignOrder.join(", ")})`);
      }
    } else if (!sql.includes(`WHERE excluded."${guard}"`)) {
      problems.push("freshness guard missing");
    }
  }

  return problems;
}

const DIALECTS: SqlDialect[] = ["sqlite", "mysql"];

let bad = 0;
for (const dialect of DIALECTS) {
  console.log(`\n${"=".repeat(78)}\n  ${dialect.toUpperCase()}\n${"=".repeat(78)}`);
  for (const { name, spec } of CASES) {
    const { sql, params } = buildUpsert(spec, dialect);
    const problems = problemsFor(spec, sql, params, dialect);

    console.log(`\n── ${name}`);
    console.log(sql);
    if (problems.length) {
      bad++;
      console.log(`   ✗ ${problems.join("; ")}`);
    } else {
      const cols = Object.keys(spec.values).length;
      console.log(`   ✓ ${cols} columns, ${Object.keys(spec.update).length} updated${spec.onlyIfNewer ? ", freshness-guarded" : ""}`);
    }
  }
}

console.log(
  bad
    ? `\n${bad} case(s) failed`
    : `\nAll ${CASES.length} cases consistent across ${DIALECTS.length} dialects`,
);
console.log(
  "\nNote: this checks the shape of the SQL, not that a server accepts or executes it.\n" +
  "The MySQL branch has never run against a real MariaDB.",
);
process.exit(bad ? 1 : 0);
