// Whose call is a scheduler's call?
//
// Every provider call an API route makes inherits its context from `getWorkspace()`. Nothing
// inherits anything on a timer: the seven schedulers and the detached job runner start their own
// executions, so a call made inside one is logged against nobody unless the scheduler says who it
// is for. That is the whole of Task 8, and it is exactly the kind of change a source grep cannot
// check — an `import { withCallContext }` sitting at the top of a file proves nothing about
// whether the provider work happens inside the wrapper or three lines above it.
//
// So each tick is driven for real. The module graph underneath is stubbed (Prisma, the raw-SQL
// helper, and whichever module actually spends the money), the stub for the spending module makes
// a genuine `loggedFetch` against a stubbed global fetch, and the assertion is on the rows that
// came out: the userId and feature the log actually recorded. Wrap the wrong scope and the row
// comes back with `userId: null`, which is precisely the failure worth catching.
//
// The tick is reached by intercepting `setTimeout` around `start*Scheduler()` and keeping the
// function it registers. Every scheduler hands its tick straight to the timer, so what the test
// then calls is the exact reference production will call — not an exported twin that happens to
// share a body and could drift from it. It also costs the schedulers nothing: no test-only export,
// no restructuring, nothing in the shipped files that exists for this file's benefit.
//
// `sync` is the one that logs a null user on purpose. `runGscSync()` is instance-wide — one run
// serving every due user — so there is no owner to name, and naming one of them would bill one
// person's calls to another. The test asserts the null, so a later "fix" that picks the first due
// user fails here rather than in production.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The log module is loaded in `before`, not statically, and that is not a style choice. It
// imports `@/lib/prisma`; a static import here would run before the stubs below are registered,
// putting the real Prisma client in the module cache where every later resolution finds it —
// including the one inside the retention sweep, which would then query a real database.
type LogModule = typeof import("./providerLog/log");
let log!: LogModule;
before(async () => { log = await import("./providerLog/log"); });

// ── the world the stubs read ─────────────────────────────────────────────────────────────────
// One mutable object on globalThis, because the stub files are plain CommonJS written to a temp
// directory and cannot import anything from this test's module graph.

type World = Record<string, any>;
const world: World = {};
(globalThis as unknown as { __sched: World }).__sched = world;

/** Every table, empty. */
const noRows = { findMany: async () => [], findFirst: async () => null, aggregate: async () => ({ _sum: {} }), groupBy: async () => [], create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) };

/**
 * The world a module finds at import time.
 *
 * `log.ts` reads `prisma.providerCall` while it is still evaluating, to warn about a client that
 * predates the model, so the stub has to answer from the first moment — not from the first test.
 */
function baseline(): void {
  for (const k of Object.keys(world)) if (k !== "call") delete world[k];
  world.prisma = new Proxy({}, { get: () => noRows });
  world.raw = { rawQuery: async () => [], rawExec: async () => undefined };
}
baseline();

/** What a stubbed provider module does instead of spending money: one logged call. */
world.call = async (endpoint = "https://provider.test/v1/thing") => {
  const { call } = await log.loggedFetch(endpoint, {}, { provider: "test" });
  call.finish({ status: 200 });
};

const dir = mkdtempSync(join(tmpdir(), "opengsc-sched-"));
const stub = (name: string, src: string) => {
  const p = join(dir, name);
  writeFileSync(p, src);
  return pathToFileURL(p).href;
};

/** A stub whose functions all forward to `globalThis.__sched[ns]`, plus any constants. */
const forward = (ns: string, names: string[], consts: Record<string, unknown> = {}) =>
  [
    ...Object.entries(consts).map(([k, v]) => `exports.${k} = ${JSON.stringify(v)};`),
    ...names.map(n => `exports.${n} = (...a) => globalThis.__sched.${ns}.${n}(...a);`),
  ].join("\n");

const STUBS: Record<string, string> = {
  "@/lib/prisma": stub("prisma.cjs", "exports.prisma = new Proxy({}, { get: (_t, k) => globalThis.__sched.prisma[k] });"),
  "@/lib/db/raw": stub("raw.cjs", forward("raw", ["rawQuery", "rawExec"])),
  "@/lib/rank": stub("rank.cjs", forward("rank", ["getUserSerpCreds", "checkSiteKeywords"], { RANK_STALE_MS: 72_000_000 })),
  "@/lib/aeoTracker": stub("aeoTracker.cjs", forward("aeo", ["getUserAeoCreds", "hasAnyAeoCreds", "siteAeoConfig", "checkSiteQuestions"], { AEO_STALE_MS: 86_400_000 })),
  "@/lib/clarityFetch": stub("clarityFetch.cjs", forward("clarity", ["runClarityFetch"])),
  "@/lib/notify": stub("notify.cjs", forward("notify", ["notifyUser"])),
  "@/lib/digest": stub("digest.cjs", forward("digest", ["buildDigest", "aiSummary", "getDigestSettings", "saveDigestSettings"])),
  "@/lib/gscSync": stub("gscSync.cjs", forward("gsc", ["runGscSync", "isSyncInProgress"])),
  "@/lib/syncSchedule": stub("syncSchedule.cjs", forward("syncSchedule", ["getSyncSchedule", "saveSyncSchedule", "isDue"])),
  "@/lib/seo/metrics": stub("metrics.cjs", forward("metrics", ["fetchKeywordMetrics", "estimateKeywordUnits"])),
  "@/lib/seo/metricsStore": stub("metricsStore.cjs", forward("metricsStore", [
    "readKeywordCache", "writeKeywordCache", "staleKeywords", "recordUsage", "releaseUnusedUnits", "withinCap", "normalizeKeyword",
  ])),
  "@/lib/seo/market": stub("market.cjs", forward("market", ["marketFor"])),
  // ── the detached job runner's own graph
  "next/server": stub("next-server.cjs", "exports.NextResponse = { json: (b, i) => ({ body: b, status: i && i.status || 200 }) };"),
  "@/lib/auth": stub("auth.cjs", "exports.authOptions = {};"),
  "@/lib/team/workspace": stub("workspace.cjs", forward("workspace", ["workspaceUserId"])),
  "@/lib/seo/generate": stub("generate.cjs", forward("generate", ["genByType"])),
  "@/lib/mcp/shared": stub("mcpShared.cjs", forward("mcpShared", ["resolveAiFallbacks"])),
  "@/lib/jobs/lifecycle": stub("lifecycle.cjs", forward("lifecycle", ["failStaleSeoJobs", "touchSeoJob", "withSeoJobHeartbeat"])),
  "@/lib/seo/historyServer": stub("historyServer.cjs", forward("historyServer", ["saveJobToHistory"])),
  "@/lib/seo/providerPing": stub("providerPing.cjs", forward("providerPing", ["pickLiveProvider"])),
};

// `module.registerHooks` is newer than this project's @types/node (^20); typing it here is cheaper
// than an upgrade nothing else has asked for. Same shape as workspaceCallContext.test.ts.
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (s: string, c: unknown) => unknown,
) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = STUBS[specifier];
    return url ? { url, format: "commonjs", shortCircuit: true } : nextResolve(specifier, context);
  },
});

// ── driving a tick ───────────────────────────────────────────────────────────────────────────

/** A fresh, silent world: every table empty, every helper a no-op. Tests fill in what they need. */
function reset(): void {
  baseline();
  log.__setWriterForTests();
}

/**
 * The tick a scheduler actually registers.
 *
 * `start*Scheduler()` does nothing but log a line and hand its tick to `setTimeout`/`setInterval`,
 * so replacing those globals for the length of that call yields the real callback and schedules
 * nothing. Memoized because every scheduler guards against being started twice, and two tests
 * share the alert one.
 */
const ticks = new Map<string, () => unknown>();
async function tickOf(name: string, load: () => Promise<any>, start: string): Promise<() => unknown> {
  const cached = ticks.get(name);
  if (cached) return cached;
  const mod = await load();
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let captured: (() => unknown) | undefined;
  const capture = ((fn: () => unknown) => { captured ??= fn; return 0 as unknown as NodeJS.Timeout; });
  globalThis.setTimeout = capture as unknown as typeof setTimeout;
  globalThis.setInterval = capture as unknown as typeof setInterval;
  try {
    mod[start]();
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.ok(captured, `${start}() must register its tick on a timer for this to test anything`);
  ticks.set(name, captured!);
  return captured!;
}

/** Run a tick with `fetch` replaced, then drain the log's queue and hand back the rows. */
async function rowsFrom(tick: () => unknown): Promise<{ userId: string | null; feature: string | null }[]> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const started = tick();
    if (typeof (started as { then?: unknown } | undefined)?.then === "function") await started;
    // warmup-cron registers `() => { tick().catch(...) }`, which hands back nothing to await, so
    // awaiting the callback is not enough on its own. Everything under test resolves on the
    // microtask queue — the fetch stub included — so draining the turn queue settles it.
    for (let i = 0; i < 50; i++) await new Promise(res => setImmediate(res));
  } finally {
    globalThis.fetch = original;
  }
  await log.flushProviderLog();
  return log.__rows().map(r => ({ userId: r.userId, feature: r.feature }));
}

// ── the seven schedulers ─────────────────────────────────────────────────────────────────────

test("rank-cron logs its calls against the site's owner", async () => {
  reset();
  world.prisma = { site: { findMany: async () => [{ id: "s1", url: "https://a.test", userId: "u-rank" }] } };
  world.rank = {
    getUserSerpCreds: async () => ({ provider: "test", apiKey: "k" }),
    checkSiteKeywords: async () => { await world.call(); return { checked: 1, errors: 0, remaining: 0 }; },
  };
  const tick = await tickOf("rank", () => import("./rankScheduler"), "startRankScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-rank", feature: "rank-cron" }]);
});

test("aeo-cron logs its calls against the site's owner", async () => {
  reset();
  world.prisma = { site: { findMany: async () => [{ id: "s1", url: "https://a.test", userId: "u-aeo" }] } };
  world.aeo = {
    getUserAeoCreds: async () => ({}),
    hasAnyAeoCreds: () => true,
    siteAeoConfig: () => ({}),
    checkSiteQuestions: async () => { await world.call(); return { checked: 1, remaining: 0 }; },
  };
  const tick = await tickOf("aeo", () => import("./aeoScheduler"), "startAeoScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-aeo", feature: "aeo-cron" }]);
});

test("clarity-cron logs its calls against the site's owner", async () => {
  reset();
  world.prisma = {
    site: { findMany: async () => [{ id: "s1", url: "https://a.test", userId: "u-clarity" }] },
    claritySnapshot: { findFirst: async () => null },
  };
  world.clarity = { runClarityFetch: async () => { await world.call(); return { ok: true }; } };
  const tick = await tickOf("clarity", () => import("./clarityScheduler"), "startClarityScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-clarity", feature: "clarity-cron" }]);
});

test("clarity-cron asks the database for the owner it has to name", async () => {
  reset();
  let select: any = null;
  world.prisma = {
    site: { findMany: async (a: any) => { select = a?.select; return []; } },
    claritySnapshot: { findFirst: async () => null },
  };
  world.clarity = { runClarityFetch: async () => ({ ok: true }) };
  const tick = await tickOf("clarity", () => import("./clarityScheduler"), "startClarityScheduler");
  await rowsFrom(tick);
  assert.equal(select?.userId, true, "the site query must select userId — it cannot attribute what it never read");
});

test("digest-cron logs its calls against the user being digested", async () => {
  reset();
  world.raw = { rawQuery: async (sql: string) => (String(sql).includes("digestSettings") ? [{ id: "u-digest" }] : []), rawExec: async () => undefined };
  world.prisma = { digest: { create: async () => ({}) } };
  world.digest = {
    getDigestSettings: async () => ({
      enabled: true, hourUtc: new Date().getUTCHours(), frequency: "daily",
      tag: "", days: 7, ai: true, lang: "en", lastSentAt: null,
    }),
    saveDigestSettings: async () => undefined,
    buildDigest: async () => ({ content: "c" }),
    aiSummary: async () => { await world.call(); return "s"; },
  };
  world.notify = { notifyUser: async () => true };
  const tick = await tickOf("digest", () => import("./digestScheduler"), "startDigestScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-digest", feature: "digest-cron" }]);
});

test("alert-cron logs its calls against the user being alerted", async () => {
  reset();
  world.raw = { rawQuery: async (sql: string) => (String(sql).includes("SELECT id FROM") ? [{ id: "u-alert" }] : []), rawExec: async () => undefined };
  world.prisma = new Proxy({
    site: { findMany: async () => [{ id: "s1", url: "https://a.test" }] },
    trackedKeyword: { findMany: async () => [{ id: "k1", siteId: "s1", keyword: "kw", country: "us", lastPosition: 30, prevPosition: 3 }] },
    alertEvent: { create: async () => ({}), updateMany: async () => ({ count: 1 }) },
  } as Record<string, unknown>, { get: (t, k) => (t as any)[k] ?? noRows });
  world.notify = { notifyUser: async () => { await world.call(); return true; } };
  const tick = await tickOf("alert", () => import("./alertScheduler"), "startAlertScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-alert", feature: "alert-cron" }]);
});

test("warmup-cron logs its calls against the user whose budget is spent", async () => {
  reset();
  world.raw = {
    rawQuery: async () => [{ seoSettings: JSON.stringify({ seoKey_ahrefs: "k", seoWarmupSchedule: { enabled: true, cap: 100, withDifficulty: false, lastRunAt: null } }) }],
    rawExec: async () => undefined,
  };
  world.prisma = {
    user: { findMany: async () => [{ id: "u-warm" }] },
    site: { findMany: async () => [{ id: "s1", url: "https://a.test", siteId: "sc", market: "us" }] },
    dailyMetric: { groupBy: async () => [{ query: "kw" }] },
  };
  world.market = { marketFor: () => "us" };
  world.metricsStore = {
    normalizeKeyword: (s: string) => s,
    readKeywordCache: async () => ({}),
    staleKeywords: () => ["kw"],
    withinCap: async () => true,
    recordUsage: async () => undefined,
    releaseUnusedUnits: async () => undefined,
    writeKeywordCache: async () => undefined,
  };
  world.metrics = {
    estimateKeywordUnits: () => 1,
    fetchKeywordMetrics: async () => { await world.call(); return { items: [{ keyword: "kw" }] }; },
  };
  const tick = await tickOf("warmup", () => import("./warmupScheduler"), "startWarmupScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: "u-warm", feature: "warmup-cron" }]);
});

test("sync-cron logs a null user, because one instance-wide run has no single owner", async () => {
  reset();
  world.raw = { rawQuery: async () => [{ id: "u-a" }, { id: "u-b" }], rawExec: async () => undefined };
  world.syncSchedule = {
    getSyncSchedule: async () => ({ enabled: true, hour: 3, lastRunAt: null }),
    saveSyncSchedule: async () => undefined,
    isDue: () => true,
  };
  world.gsc = { isSyncInProgress: () => false, runGscSync: async () => { await world.call(); return {}; } };
  const tick = await tickOf("sync", () => import("./syncScheduler"), "startSyncScheduler");
  assert.deepEqual(await rowsFrom(tick), [{ userId: null, feature: "sync-cron" }]);
});

// ── the detached job runner ──────────────────────────────────────────────────────────────────

test("a detached job logs against the job's own user, after its request is gone", async () => {
  reset();
  world.prisma = { seoJob: { update: async () => ({}) } };
  world.lifecycle = {
    failStaleSeoJobs: async () => undefined,
    touchSeoJob: async () => undefined,
    withSeoJobHeartbeat: async (_id: string, p: Promise<unknown>) => p,
  };
  world.providerPing = { pickLiveProvider: async () => ({ ok: true }) };
  world.historyServer = { saveJobToHistory: async () => undefined };
  world.generate = { genByType: async () => { await world.call(); return { ok: true, data: {} }; } };
  const { runJob } = await import("../app/api/seo/jobs/route");
  // Awaited here, not fire-and-forget: what is under test is that the context is established
  // inside the detached function, where the work actually runs.
  assert.deepEqual(
    await rowsFrom(() => runJob("u-job", { id: "j1", type: "outline" }, {})),
    [{ userId: "u-job", feature: "outline" }],
  );
});

// ── retention rides on the quietest tick ─────────────────────────────────────────────────────

test("the alert tick is where the provider log is swept", async () => {
  reset();
  const seen: any[] = [];
  world.prisma = new Proxy({
    providerCall: {
      findMany: async (a: any) => { seen.push(a.where); return []; },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
  } as Record<string, unknown>, { get: (t, k) => (t as any)[k] ?? noRows });
  const tick = await tickOf("alert", () => import("./alertScheduler"), "startAlertScheduler");
  await rowsFrom(tick);
  // Both phases, in the order that matters: bodies (the pass that filters on a body still being
  // there) before rows, and the row cutoff reaching much further back than the body one.
  assert.equal(seen.length, 2, "the sweep must run on the tick, not only when someone calls it");
  assert.ok(Array.isArray(seen[0].OR), "the first pass is the one that clears bodies");
  assert.ok(seen[1].at.lt < seen[0].at.lt, "rows are kept far longer than the bodies they carried");
});
