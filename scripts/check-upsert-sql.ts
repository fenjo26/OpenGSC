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
// Prisma client, because the builder shares a module with the function that executes — which is
// why the run prints one line of client debug output before the first case. Harmless, and worth
// knowing before someone reads it as a failure.

import { buildUpsert, type UpsertSpec } from "../src/lib/db/upsert";

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

let bad = 0;
for (const { name, spec } of CASES) {
  const { sql, params } = buildUpsert(spec);
  const cols = Object.keys(spec.values).length;

  // Cheap invariants that would catch a builder bug without anyone reading the SQL.
  const problems: string[] = [];
  if (params.length !== cols) problems.push(`params ${params.length} != columns ${cols}`);
  if ((sql.match(/\?/g) ?? []).length !== cols) problems.push("placeholder count != column count");
  for (const [col, mode] of Object.entries(spec.update)) {
    if (mode === "keep" && !sql.includes(`COALESCE(excluded."${col}"`)) problems.push(`${col}: COALESCE missing`);
    if (mode === "add" && !sql.includes(`"${spec.table}"."${col}" + excluded."${col}"`)) problems.push(`${col}: not accumulating`);
  }
  if (spec.onlyIfNewer && !sql.includes(`WHERE excluded."${spec.onlyIfNewer}"`)) problems.push("freshness guard missing");

  console.log(`\n── ${name}`);
  console.log(sql);
  if (problems.length) {
    bad++;
    console.log(`   ✗ ${problems.join("; ")}`);
  } else {
    console.log(`   ✓ ${cols} columns, ${Object.keys(spec.update).length} updated${spec.onlyIfNewer ? ", freshness-guarded" : ""}`);
  }
}

console.log(bad ? `\n${bad} case(s) failed` : `\nAll ${CASES.length} cases consistent`);
process.exit(bad ? 1 : 0);
