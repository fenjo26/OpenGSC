import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The index-check queue against a scratch sqlite database, same setup as
// magiclinks/toIndexer.test.ts: DATABASE_URL must exist before ../prisma is imported, hence the
// dynamic imports. The DDL mirrors the models' scalar columns with the schema's defaults so
// prisma's create()/updateMany() work unchanged. The provider call itself is NOT driven here —
// these tests cover collection, the one-active-run rule, cancel, progress aggregation and the
// not-found list; the paid path is exercised end-to-end on a real provider (aparser = free).

const dir = mkdtempSync(join(tmpdir(), "opengsc-icq-"));
type PrismaClientT = (typeof import("../prisma"))["prisma"];
let prisma: PrismaClientT;
let mod: typeof import("./checkQueue");

const USER = "u1";
const SITE = "site1";

before(async () => {
  process.env.OPENGSC_CHECK_QUEUE_OFF = "1"; // createRun must not fire a real provider call
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  mod = await import("./checkQueue");

  await prisma.$executeRawUnsafe(`CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "seoSettings" TEXT,
    "mcpToken" TEXT,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "workspaceName" TEXT,
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordUpdatedAt" DATETIME,
    "telegramBotToken" TEXT,
    "telegramChatId" TEXT,
    "slackWebhook" TEXT,
    "alertSettings" TEXT,
    "digestSettings" TEXT,
    "syncSettings" TEXT,
    "neuralIndexerToken" TEXT,
    "xmlRiverUserId" TEXT,
    "xmlRiverApiKey" TEXT,
    "twoIndexToken" TEXT
, "auditQueueSettings" TEXT, "extAllowedIds" TEXT, "extToken" TEXT, "footprintIgnore" TEXT, "gbpToken" TEXT, "notifyChannels" TEXT, "reportBranding" TEXT, "uptimeSettings" TEXT, "widgetKey" TEXT, "widgetSettings" TEXT, "genQueueSettings" TEXT, "xmlRiverPriceUsd" REAL)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tags" TEXT,
    "brandedKeywords" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "market" TEXT,
    "archivedAt" DATETIME,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "aeoModel" TEXT,
    "aeoCountry" TEXT,
    "aeoCity" TEXT,
    "aeoLanguage" TEXT,
    "aeoAuto" BOOLEAN NOT NULL DEFAULT false,
    "sitemapUrl" TEXT,
    "crawlInterval" TEXT,
    "lastSitemapSync" DATETIME,
    "clarityToken" TEXT,
    "clarityProjectId" TEXT,
    "clarityInterval" TEXT,
    "ga4PropertyId" TEXT,
    "ga4PropertyName" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shareToken" TEXT, "auditSettings" TEXT, "aeoCompetitors" TEXT, "backlinkNiche" TEXT, "indexInspect" TEXT, "mentionSettings" TEXT, "queryHistoryFrom" DATETIME,
    CONSTRAINT "Site_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "SitemapUrl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sourceSitemap" TEXT,
    "sitemapType" TEXT NOT NULL DEFAULT 'standard',
    "lastmod" TEXT,
    "lastmodValid" BOOLEAN,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "newsCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenSync" TEXT,
    "missingSyncs" INTEGER NOT NULL DEFAULT 0,
    "inventoryStatus" TEXT NOT NULL DEFAULT 'active',
    "changeStatus" TEXT NOT NULL DEFAULT 'added',
    "contentHash" TEXT,
    "contentType" TEXT,
    "contentHttpStatus" INTEGER,
    "contentTitle" TEXT,
    "contentCheckedAt" DATETIME,
    "contentLastmod" TEXT,
    "lastmodReliability" TEXT NOT NULL DEFAULT 'unknown',
    "googleStatus" TEXT,
    "googleCoverage" TEXT,
    "googleReason" TEXT,
    "googleChecked" DATETIME,
    "xrStatus" TEXT,
    "xrChecked" DATETIME,
    "twoIndexStatus" TEXT,
    "twoIndexAt" DATETIME,
    "neuralStatus" TEXT,
    "neuralAt" DATETIME,
    "neuralQueue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL, "googleCanonical" TEXT, "googleLastCrawl" DATETIME, "googleNextCheck" DATETIME, "googleVerdict" TEXT, "serpIndexChecked" DATETIME, "serpIndexProvider" TEXT, "serpIndexStatus" TEXT,
    CONSTRAINT "SitemapUrl_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "SiteBacklink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "urlFrom" TEXT NOT NULL,
    "urlFromNorm" TEXT NOT NULL,
    "urlTo" TEXT NOT NULL DEFAULT '',
    "domainFrom" TEXT NOT NULL DEFAULT '',
    "apiSeen" BOOLEAN NOT NULL DEFAULT false,
    "apiLost" BOOLEAN NOT NULL DEFAULT false,
    "apiLostReason" TEXT NOT NULL DEFAULT '',
    "apiAnchor" TEXT NOT NULL DEFAULT '',
    "apiAlt" TEXT NOT NULL DEFAULT '',
    "apiDofollow" BOOLEAN NOT NULL DEFAULT true,
    "apiNofollow" BOOLEAN NOT NULL DEFAULT false,
    "apiSponsored" BOOLEAN NOT NULL DEFAULT false,
    "apiUgc" BOOLEAN NOT NULL DEFAULT false,
    "apiContent" BOOLEAN NOT NULL DEFAULT true,
    "apiImage" BOOLEAN NOT NULL DEFAULT false,
    "apiJsCrawl" BOOLEAN NOT NULL DEFAULT false,
    "apiDr" REAL,
    "apiHttpCode" INTEGER,
    "apiLinkType" TEXT NOT NULL DEFAULT '',
    "apiSnippet" TEXT NOT NULL DEFAULT '',
    "apiFirstSeen" TEXT NOT NULL DEFAULT '',
    "apiLastSeen" TEXT NOT NULL DEFAULT '',
    "apiFetchedAt" DATETIME,
    "checkStatus" TEXT NOT NULL DEFAULT 'unchecked',
    "checkAnchor" TEXT NOT NULL DEFAULT '',
    "checkRel" TEXT NOT NULL DEFAULT '',
    "checkNofollow" BOOLEAN NOT NULL DEFAULT false,
    "checkSponsored" BOOLEAN NOT NULL DEFAULT false,
    "checkUgc" BOOLEAN NOT NULL DEFAULT false,
    "checkFoundUrl" TEXT NOT NULL DEFAULT '',
    "checkMatchedDomain" TEXT NOT NULL DEFAULT '',
    "checkTargetOk" BOOLEAN,
    "checkError" TEXT NOT NULL DEFAULT '',
    "checkInsecure" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" DATETIME,
    "pageStatus" TEXT NOT NULL DEFAULT 'unknown',
    "pageTitle" TEXT NOT NULL DEFAULT '',
    "pageCheckedAt" DATETIME,
    "xrStatus" TEXT NOT NULL DEFAULT '',
    "xrCheckedAt" DATETIME,
    "twoIndexStatus" TEXT NOT NULL DEFAULT '',
    "twoIndexAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'api',
    "sources" TEXT NOT NULL DEFAULT '',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "priceNote" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "purchaseProvider" TEXT NOT NULL DEFAULT '',
    "purchaseOrderId" TEXT NOT NULL DEFAULT '',
    "toxLevel" TEXT NOT NULL DEFAULT 'unknown',
    "toxScore" INTEGER,
    "toxSignals" TEXT,
    "toxCheckedAt" DATETIME,
    "disavow" BOOLEAN NOT NULL DEFAULT false,
    "disavowNote" TEXT NOT NULL DEFAULT '',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL, "apiSpamScore" INTEGER,
    CONSTRAINT "SiteBacklink_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SerpCheckRun (
    id TEXT PRIMARY KEY, userId TEXT,
    name TEXT NOT NULL DEFAULT '', provider TEXT, source TEXT NOT NULL DEFAULT 'urls',
    status TEXT NOT NULL DEFAULT 'active', statusReason TEXT NOT NULL DEFAULT '',
    consecutiveErrors INTEGER NOT NULL DEFAULT 0, pauseAfterErrors INTEGER NOT NULL DEFAULT 10,
    estCostUsd REAL, createdAt TIMESTAMP, updatedAt TIMESTAMP, finishedAt TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SerpCheckItem (
    id TEXT PRIMARY KEY, runId TEXT, url TEXT, siteId TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    verdict TEXT, matchedUrl TEXT, detail TEXT, checkedAt TIMESTAMP,
    createdAt TIMESTAMP, updatedAt TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX serpcheck_run_url ON SerpCheckItem (runId, url)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX serpcheck_run_status ON SerpCheckItem (runId, status)`);

  // A configured SERP provider so estimate/create pass the creds gate.
  await prisma.user.create({
    data: { id: USER, isOwner: true, seoSettings: JSON.stringify({ seoSerpProvider: "serper", seoKey_serper: "k" }) },
  });
  await prisma.site.create({ data: { id: SITE, userId: USER, url: "https://own.example/", siteId: "sc-domain:own.example" } });
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

// Run-creating tests each get their own user: the one-active-run rule is the feature under
// test, and a shared user would make tests interfere through it (a leftover active run from a
// previous test blocks the next createRun — exactly as designed).
let userSeq = 0;
async function mkUser(): Promise<string> {
  const id = `run-u${++userSeq}`;
  await prisma.user.create({
    data: { id, isOwner: true, seoSettings: JSON.stringify({ seoSerpProvider: "serper", seoKey_serper: "k" }) },
  });
  return id;
}
const url = (host: string, path: string) => `https://${host}${path}`;

test("estimateRun (urls): dedupes by comparison form; tracking params are not identity, content params are", async () => {
  const out = await mod.estimateRun(USER, "", {
    kind: "urls",
    urls: [
      url("own.example", "/a"),
      url("www.own.example", "/a/"),            // www + trailing slash — the same URL
      url("own.example", "/a?utm_source=x"),    // a tracking param is not identity either — same URL
      url("own.example", "/list?page=2"),       // a content param IS identity — a different URL
      url("foreign.example", "/donor-post"),
      "not a url",
    ],
  });
  assert.equal(out.ok, true);
  // /a (three spellings), /list?page=2, the donor post — three URLs.
  assert.equal(out.collected, 3);
  assert.equal(out.estimate!.provider, "serper");
  assert.equal(out.estimate!.costUsd, 0.003); // serper: $0.001 per query, known price
});

test("estimateRun (sites/pending): only never-checked inventory rows", async () => {
  await prisma.sitemapUrl.create({
    data: { id: "sm1", siteId: SITE, url: url("own.example", "/fresh"), firstSeenAt: new Date() },
  });
  await prisma.sitemapUrl.create({
    data: { id: "sm2", siteId: SITE, url: url("own.example", "/google-said"), googleStatus: "Submitted and indexed", googleChecked: new Date(), firstSeenAt: new Date() },
  });
  const out = await mod.estimateRun(USER, "", { kind: "sites", siteIds: [SITE], filter: "pending" });
  assert.equal(out.ok, true);
  assert.equal(out.collected, 1); // sm2 was inspected by Google — not "pending"
});

test("estimateRun (donors): purchased donors only, deduped", async () => {
  await prisma.siteBacklink.createMany({
    data: [
      { id: "b1", siteId: SITE, urlFrom: url("donor1.example", "/p"), urlFromNorm: url("donor1.example", "/p"), purchaseProvider: "fieldlink", addedAt: new Date() },
      { id: "b2", siteId: SITE, urlFrom: url("donor1.example", "/p"), urlFromNorm: url("donor1.example", "/p"), purchaseProvider: "369", addedAt: new Date() },
      { id: "b3", siteId: SITE, urlFrom: url("plain.example", "/organic"), urlFromNorm: url("plain.example", "/organic"), purchaseProvider: "", addedAt: new Date() },
    ],
  });
  const out = await mod.estimateRun(USER, "", { kind: "donors" });
  assert.equal(out.ok, true);
  assert.equal(out.collected, 1); // the purchased donor once; the organic backlink is not a donor
});

test("createRun: one active run per user; a zombie active run does not block", async () => {
  const u = await mkUser();
  const first = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/x")] }, { name: "first" });
  assert.equal(first.ok, true);

  const second = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/y")] });
  assert.equal(second.ok, false);
  assert.equal(second.error, "run_active");
  assert.equal(second.runId, first.runId); // the refusal names the blocker

  // An "active" run with no live items is a zombie — closed automatically, not a blocker.
  const zombie = await prisma.serpCheckRun.create({ data: { userId: u, provider: "serper", status: "active" } });
  assert.equal(await mod.cancelRun(u, first.runId!), true);
  const after = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/z")] });
  assert.equal(after.ok, true);
  assert.equal((await prisma.serpCheckRun.findUnique({ where: { id: zombie.id } }))!.status, "done");
});

test("cancelRun: queued items are skipped, the run keeps its cancelled status and finishedAt", async () => {
  const u = await mkUser();
  const run = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/q1"), url("own.example", "/q2")] });
  assert.equal(run.ok, true);
  // The pump is not kicked in tests (OPENGSC_CHECK_QUEUE_OFF); items stay queued.
  assert.equal(await mod.cancelRun(u, run.runId!), true);
  const items = await prisma.serpCheckItem.findMany({ where: { runId: run.runId! } });
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.status === "skipped"));
  const row = await prisma.serpCheckRun.findUnique({ where: { id: run.runId! } });
  assert.equal(row!.status, "cancelled");
  assert.ok(row!.finishedAt, "a fully drained cancelled run gets its finishedAt");
});

test("resumeRun: refused while another run is active, allowed once it drains", async () => {
  const u = await mkUser();
  const a = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/r-a")] });
  assert.equal(await mod.pauseRun(u, a.runId!), true);
  const b = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/r-b")] });
  assert.equal(b.ok, true);
  const refused = await mod.resumeRun(u, a.runId!);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "run_active");
  assert.equal(await mod.cancelRun(u, b.runId!), true);
  const ok = await mod.resumeRun(u, a.runId!);
  assert.equal(ok.ok, true);
});

test("getRunStatus: counts, verdicts and the foreign-URL bucket", async () => {
  const u = await mkUser();
  // own.example belongs to USER u1, not to this test user — both URLs are foreign here, which
  // is exactly what the by-site breakdown must show for a pasted list.
  const run = await mod.createRun(u, "", { kind: "urls", urls: [url("foreign-a.example", "/v1"), url("foreign-b.example", "/v2")] });
  assert.equal(run.ok, true);
  await prisma.serpCheckItem.updateMany({
    where: { runId: run.runId!, url: url("foreign-a.example", "/v1") },
    data: { status: "completed", verdict: "not_indexed", checkedAt: new Date() },
  });
  await prisma.serpCheckItem.updateMany({
    where: { runId: run.runId!, url: url("foreign-b.example", "/v2") },
    data: { status: "completed", verdict: "indexed", checkedAt: new Date() },
  });

  const s = await mod.getRunStatus(u, run.runId!);
  assert.ok(s);
  assert.equal(s!.counts.completed, 2);
  assert.equal(s!.verdicts.not_indexed, 1);
  assert.equal(s!.verdicts.indexed, 1);
  assert.equal(s!.bySite.length, 1);
  assert.equal(s!.bySite[0].siteId, null, "pasted foreign URLs land in the null bucket");
  assert.equal(s!.bySite[0].notIndexed, 1);
});

test("getNotFoundUrls: every not_indexed verdict, no errors, no unchecked, optional site cut", async () => {
  const u = await mkUser();
  const run = await mod.createRun(u, "", { kind: "urls", urls: [url("own.example", "/nf1"), url("own.example", "/nf2"), url("own.example", "/nf3")] });
  await prisma.serpCheckItem.updateMany({ where: { runId: run.runId!, url: url("own.example", "/nf1") }, data: { status: "completed", verdict: "not_indexed" } });
  await prisma.serpCheckItem.updateMany({ where: { runId: run.runId!, url: url("own.example", "/nf2") }, data: { status: "error", verdict: "error", detail: "captcha" } });
  // nf3 stays queued — an unchecked URL must never appear in the not-found list.
  assert.deepEqual(await mod.getNotFoundUrls(u, run.runId!), [url("own.example", "/nf1")]);
  // No SitemapUrl rows exist for this test user → the siteId cut is empty, the whole-run cut is not.
  assert.deepEqual(await mod.getNotFoundUrls(u, run.runId!, "no-such-site"), []);
});

test("XR estimate: priced from the operator tariff field, honestly unknown when empty", async () => {
  const noKey = await mod.estimateRun(USER, "xmlriver", { kind: "urls", urls: [url("x.example", "/1")] });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, "no_xr_key");

  await prisma.user.update({ where: { id: USER }, data: { xmlRiverUserId: "u", xmlRiverApiKey: "k" } });
  const noPrice = await mod.estimateRun(USER, "xmlriver", { kind: "urls", urls: [url("x.example", "/1"), url("x.example", "/2")] });
  assert.equal(noPrice.ok, true);
  assert.equal(noPrice.estimate!.unknownPrice, true);
  assert.equal(noPrice.estimate!.costUsd, null);

  await prisma.user.update({ where: { id: USER }, data: { xmlRiverPriceUsd: 0.001 } });
  const priced = await mod.estimateRun(USER, "xmlriver", { kind: "urls", urls: [url("x.example", "/1"), url("x.example", "/2")] });
  assert.equal(priced.ok, true);
  assert.equal(priced.estimate!.costUsd, 0.002);
  assert.equal(priced.estimate!.unknownPrice, false);
});

// ─── the pump, offline ─────────────────────────────────────────────────────────
//
// The drain path end-to-end against the scratch DB with fetch stubbed: claim → provider
// call → settle → persist → close. No network, deterministic, and it is the only place the
// money path (recordUsage per item, error≠not_indexed on a provider 500) is actually executed.

test("pump: claims, settles verdicts, persists own-site rows, records units, closes the run", async () => {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ApiUsage (
    userId TEXT NOT NULL, provider TEXT NOT NULL, month TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId, provider, month)
  )`);
  // The inventory row the own-site verdict must land on.
  await prisma.sitemapUrl.create({
    data: { id: "sm-hit", siteId: SITE, url: url("own.example", "/hit"), firstSeenAt: new Date() },
  });

  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    // Serper takes the query in the POST body ({ q: "site:host/path" }) — dispatch on it.
    let q = "";
    try { q = String(JSON.parse(String(init?.body ?? "{}")).q ?? ""); } catch { /* not our call */ }
    if (q.includes("own.example/hit")) {
      return new Response(JSON.stringify({ organic: [{ link: url("own.example", "/hit"), title: "hit", position: 1 }] }), { status: 200 });
    }
    if (q.includes("own.example/miss")) {
      return new Response(JSON.stringify({ organic: [] }), { status: 200 }); // honest empty SERP → not_indexed
    }
    if (q.includes("own.example/boom")) {
      return new Response("Internal Server Error", { status: 500 }); // provider failure → error, NEVER not_indexed
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  // This run must belong to USER — the site (and its inventory row) is USER's, and the
  // own-site persistence resolves ownership by user. No earlier test left USER a run.
  const u = USER;
  // Sweep leftovers from earlier tests: enabling the pump drains EVERY active run, and the
  // one-active-run tests above deliberately leave some alive. Cancel them and skip their items.
  const leftovers = await prisma.serpCheckRun.findMany({ where: { status: "active" }, select: { id: true } });
  for (const l of leftovers) {
    await prisma.serpCheckItem.updateMany({ where: { runId: l.id, status: "queued" }, data: { status: "skipped", detail: "test cleanup" } });
    await prisma.serpCheckRun.update({ where: { id: l.id }, data: { status: "cancelled", finishedAt: new Date() } });
  }
  delete process.env.OPENGSC_CHECK_QUEUE_OFF; // let the pump run for this test
  try {
    const run = await mod.createRun(u, "", {
      kind: "urls",
      urls: [url("own.example", "/hit"), url("own.example", "/miss"), url("own.example", "/boom")],
    });
    assert.equal(run.ok, true);

    // Wait for the queue to drain (3 sequential calls × ~800 ms pacing + settle).
    const deadline = Date.now() + 20_000;
    let statuses: { status: string }[] = [];
    while (Date.now() < deadline) {
      statuses = await prisma.serpCheckItem.findMany({ where: { runId: run.runId! }, select: { status: true } });
      if (statuses.length === 3 && statuses.every(s => s.status !== "queued" && s.status !== "running")) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(statuses.filter(s => s.status === "completed").length, 2, "hit + miss settle as completed");
    assert.equal(statuses.filter(s => s.status === "error").length, 1, "the provider 500 is an error item");

    // Verdicts carry the exact vocabulary and SitemapUrl got the own-site row.
    const items = await prisma.serpCheckItem.findMany({ where: { runId: run.runId! } });
    const byUrl = new Map(items.map(i => [i.url, i.verdict]));
    assert.equal(byUrl.get(url("own.example", "/hit")), "indexed");
    assert.equal(byUrl.get(url("own.example", "/miss")), "not_indexed");
    assert.equal(byUrl.get(url("own.example", "/boom")), "error");
    const stored = await prisma.sitemapUrl.findUnique({ where: { id: "sm-hit" } });
    assert.equal(stored!.serpIndexStatus, "indexed");
    assert.equal(stored!.serpIndexProvider, "serper");

    // Units: 1 per check (serper $0.001 → usdToUnits = 1), recorded before each call — 3 total.
    const usage = await prisma.apiUsage.findUnique({ where: { userId_provider_month: { userId: u, provider: "serper", month: new Date().toISOString().slice(0, 7) } } });
    assert.ok(usage);
    assert.equal(usage!.units, 3);

    // The run closed itself: one provider error, but the breaker needs 10 — status done.
    const row = await prisma.serpCheckRun.findUnique({ where: { id: run.runId! } });
    assert.equal(row!.status, "done");
    assert.ok(row!.finishedAt);
    assert.equal(calls.length, 3, "exactly one provider call per item");
  } finally {
    process.env.OPENGSC_CHECK_QUEUE_OFF = "1";
    globalThis.fetch = realFetch;
  }
});
