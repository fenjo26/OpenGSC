// Uniqueness-gate calibration — measures the textSimilarity distribution this instance's own
// articles actually produce, so the gate thresholds in gate.ts come from data instead of a
// guess. Runnable read-only:
//
//   npx tsx src/lib/publish/calibrate.ts
//
// Buckets (the plan's 7.6-1, measured on the SAME engine the gate uses — word-trigram Jaccard
// after normalizeForDiff, src/lib/seo/textSimilarity.ts):
//   different-topic — articles of DIFFERENT keywords. The floor: independent texts must sit
//                     far below any blocking threshold.
//   same-topic      — articles sharing one keyword (regenerations of the same brief). The
//                     dangerous middle the gate must let through only if truly distinct.
//   respin          — original vs its AI adaptation: respin pairs that already exist as
//                     PublishedPost rows, plus (when the instance has AI creds configured and
//                     articles to adapt) up to MAX_RESPIN_CALLS fresh respin calls on the
//                     "respin" task slot. This is the ceiling the gate must BLOCK.
//
// Strictly read-only against the database: a dedicated better-sqlite3 connection opened with
// { readonly: true } — the driver refuses writes, which is a stronger promise than "this
// script happens not to update anything". The AI calls are the only spend, they are capped at
// MAX_RESPIN_CALLS, and they are SKIPPED entirely when no user has respin creds configured
// (the script says so and the thresholds stay on the documented prior).
//
// Output: a per-bucket min/p25/median/p75/max table plus the counts the thresholds in gate.ts
// cite. When a bucket is empty its row reads n=0 — an empty local database is an honest
// calibration outcome ("prior, provisional"), not a zero.

import "dotenv/config"; // MUST be the first import: ESM evaluates imports in order, and the
// prisma-backed modules below (resolveAiCreds, llm) read process.env.DATABASE_URL through
// their own imports. Without this a plain tsx run would silently calibrate against the
// fallback ./data/prod.db instead of the configured database.

import { textSimilarity } from "@/lib/seo/textSimilarity";
import { extractPostFromHistory } from "./historySource";
import { respinPost, type RespinCreds, type RespinInput, type RespinResult } from "./respin";
import { fetchLLM } from "@/lib/llm";
import { resolveAiCreds } from "@/lib/mcp/shared";

/** Pairwise sampling cap per bucket/topic-group: O(n²) on a full history is a bake, not a calibration. */
export const MAX_PAIRS_PER_BUCKET = 2000;
/** Hard ceiling on AI spend for one calibration run (the plan allows "up to 5"). */
export const MAX_RESPIN_CALLS = 5;

// ─── pure helpers (unit-tested in calibrate.test.ts) ─────────────────────────────

export interface CalibArticle {
  id: string;
  keyword: string;
  title: string;
  markdown: string;
}

export interface Bucket {
  name: string;
  values: number[];
}

/** Deterministic pseudo-random (mulberry32) — a reproducible sample beats a "lucky" one. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** All unordered index pairs of n items (n·(n−1)/2), capped by a seeded random sample. */
export function samplePairs(n: number, cap = MAX_PAIRS_PER_BUCKET, seed = 42): Array<[number, number]> {
  if (n < 2) return [];
  const total = (n * (n - 1)) / 2;
  if (total <= cap) {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
    return out;
  }
  const rand = rng(seed);
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  while (out.length < cap) {
    // Rejection-sample distinct indices — uniform over pairs without materialising all of them.
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    if (i === j) continue;
    const [a, b] = i < j ? [i, j] : [j, i];
    const key = a * n + b;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
  }
  return out;
}

/** Linear-interpolated percentile (p ∈ 0..100) — numpy's default, no dependency needed. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function summarize(values: number[]): { n: number; min: number; p25: number; median: number; p75: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: percentile(sorted, 0),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    max: percentile(sorted, 100),
  };
}

/** Bucket assignment by keyword: same string (trimmed, case-folded) = same topic. */
export function topicKeyOf(keyword: string): string {
  return String(keyword || "").trim().toLowerCase();
}

/**
 * The two history buckets. Same-topic groups are measured exhaustively per group (a rare
 * regeneration pair must not lose the sampling lottery against thousands of cross-topic
 * pairs); different-topic pairs are a capped sample. Pairing inside a group measures what the
 * gate must ALLOW (distinct generations of one brief); across groups what it must IGNORE.
 */
export function historyBuckets(articles: CalibArticle[], cap = MAX_PAIRS_PER_BUCKET): Bucket[] {
  const groups = new Map<string, CalibArticle[]>();
  for (const a of articles) {
    const key = topicKeyOf(a.keyword);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  const same: number[] = [];
  for (const group of groups.values()) {
    for (const [i, j] of samplePairs(group.length, cap)) {
      same.push(textSimilarity(group[i].markdown, group[j].markdown));
    }
  }
  const different: number[] = [];
  for (const [i, j] of samplePairs(articles.length, cap)) {
    const a = articles[i];
    const b = articles[j];
    if (topicKeyOf(a.keyword) && topicKeyOf(a.keyword) === topicKeyOf(b.keyword)) continue; // counted above
    different.push(textSimilarity(a.markdown, b.markdown));
  }
  return [
    { name: "different-topic", values: different },
    { name: "same-topic", values: same },
  ];
}

// ─── database reads (read-only connection) ───────────────────────────────────────

/** Resolves the same URL rule src/lib/prisma.ts applies, minus everything that writes. */
function dbFile(): string {
  const rawUrl = process.env.DATABASE_URL || "file:./data/prod.db";
  return rawUrl.replace(/^file:/, "");
}

type ReadonlyDb = {
  prepare(sql: string): { all: (...args: unknown[]) => unknown[] };
  close(): void;
};

async function openReadonly(): Promise<ReadonlyDb> {
  // better-sqlite3 is a native addon without bundled types and must stay out of the bundler's
  // graph — the same dynamic + ts-ignore import execute_sql uses. readonly: true makes the
  // connection physically incapable of writing, which is the whole point of this script.
  // @ts-ignore -- no declaration file for better-sqlite3
  const { default: Database } = (await import(/* turbopackIgnore: true */ "better-sqlite3")) as any;
  return new Database(dbFile(), { readonly: true, fileMustExist: true }) as ReadonlyDb;
}

function loadArticles(db: ReadonlyDb): CalibArticle[] {
  const rows = db
    .prepare(`SELECT id, keyword, type, data FROM SeoHistory WHERE type IN ('text', 'landing') ORDER BY createdAt DESC`)
    .all() as Array<{ id: string; keyword: string; type: string; data: string }>;
  const out: CalibArticle[] = [];
  for (const r of rows) {
    const extracted = extractPostFromHistory({ type: r.type, keyword: r.keyword, data: r.data });
    if (extracted) out.push({ id: r.id, keyword: r.keyword, ...extracted });
  }
  return out;
}

/** Existing respin pairs: PublishedPost rows produced with respin, joined back to their source. */
function loadRespinPairs(db: ReadonlyDb, articles: CalibArticle[]): number[] {
  const rows = db
    .prepare(`SELECT markdown, historyId FROM PublishedPost WHERE respinUsed = 1 AND historyId IS NOT NULL`)
    .all() as Array<{ markdown: string; historyId: string }>;
  const byId = new Map(articles.map(a => [a.id, a.markdown]));
  const out: number[] = [];
  for (const r of rows) {
    const source = byId.get(r.historyId);
    if (!source) continue; // the history row is gone — no honest pair without the original
    out.push(textSimilarity(source, r.markdown));
  }
  return out;
}

/** The first user + resolved respin creds, or null when the instance has no creds. */
async function respinCredsIfAny(db: ReadonlyDb): Promise<{ userId: string; creds: RespinCreds } | null> {
  const users = db.prepare(`SELECT id FROM User LIMIT 1`).all() as Array<{ id: string }>;
  if (!users.length) return null;
  const creds = await resolveAiCreds(users[0].id, {}, "respin");
  if (!creds.aiApiKey) return null;
  return { userId: users[0].id, creds };
}

/** The respin call the script makes — injected so tests can stub the model, never the engine. */
export type RespinCall = (input: RespinInput, creds: RespinCreds) => Promise<RespinResult>;

/**
 * Up to MAX_RESPIN_CALLS fresh respins on representative articles (longest first — a short
 * stub adapts into anything and measures nothing). Returns the attempted call count so the
 * run report can state the spend honestly (a call that errors may still have billed).
 */
export async function generateRespinPairs(
  articles: CalibArticle[],
  creds: RespinCreds,
  call: RespinCall,
): Promise<{ values: number[]; callsSpent: number; errors: string[] }> {
  const values: number[] = [];
  const errors: string[] = [];
  const picks = [...articles].sort((a, b) => b.markdown.length - a.markdown.length).slice(0, MAX_RESPIN_CALLS);
  for (const a of picks) {
    try {
      const result = await call(
        { platform: "wordpress", sourceTitle: a.title, sourceMarkdown: a.markdown, projectDomain: "money.example.com" },
        creds,
      );
      values.push(textSimilarity(a.markdown, result.body));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { values, callsSpent: picks.length, errors };
}

// ─── the run ─────────────────────────────────────────────────────────────────────

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : "—";
}

async function main(): Promise<void> {
  const db = await openReadonly();
  try {
    const articles = loadArticles(db);
    const buckets = historyBuckets(articles);

    const storedRespin = loadRespinPairs(db, articles);
    let respinValues = storedRespin;
    let callsSpent = 0;
    const errors: string[] = [];

    if (storedRespin.length === 0 && articles.length > 0) {
      const withCreds = await respinCredsIfAny(db);
      if (withCreds) {
        console.log(`[calibrate] no stored respin pairs — generating up to ${MAX_RESPIN_CALLS} respin call(s) on the respin task slot…`);
        const gen = await generateRespinPairs(articles, withCreds.creds, (input, creds) => respinPost(input, creds, fetchLLM));
        respinValues = gen.values;
        callsSpent = gen.callsSpent;
        errors.push(...gen.errors);
      } else {
        console.log("[calibrate] no stored respin pairs and no AI creds configured — respin bucket left empty (thresholds stay on the documented prior)");
      }
    }
    buckets.push({ name: "respin", values: respinValues });

    console.log(`\narticles (text/landing with a body): ${articles.length}`);
    console.log(`respin AI calls spent this run: ${callsSpent}${errors.length ? ` (${errors.length} failed: ${errors[0]}…)` : ""}\n`);
    console.log("bucket            |     n | min     | p25     | median  | p75     | max");
    console.log("------------------|-------|---------|---------|---------|---------|--------");
    for (const b of buckets) {
      const s = summarize(b.values);
      console.log(
        `${b.name.padEnd(17)} | ${String(s.n).padStart(5)} | ${fmt(s.min).padStart(7)} | ${fmt(s.p25).padStart(7)} | ${fmt(s.median).padStart(7)} | ${fmt(s.p75).padStart(7)} | ${fmt(s.max).padStart(7)}`,
      );
    }
    console.log(
      "\nThresholds for src/lib/publish/gate.ts: block ABOVE the same-topic ceiling (into respin\nterritory), warn where same-topic overlap starts looking like shared facture. Empty buckets\nmean no local data — keep the documented prior and re-run after real publications exist.",
    );
  } finally {
    db.close();
  }
}

// Run only when executed directly (the unit tests import the pure helpers, not main).
if (process.argv[1] && /calibrate\.(ts|js|mjs)$/.test(process.argv[1])) {
  void main().catch(e => {
    console.error("[calibrate] failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
