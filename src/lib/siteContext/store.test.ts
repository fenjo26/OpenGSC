import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The site-context store against a scratch sqlite database (same setup as purchases.test.ts):
// DATABASE_URL before ../prisma import, dynamic imports, one tree. The DDL mirrors the model's
// scalar columns so prisma's upserts work unchanged.

const dir = mkdtempSync(join(tmpdir(), "opengsc-ctx-"));
let prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown>; $disconnect: () => Promise<void> };

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (
    id TEXT PRIMARY KEY, userId TEXT, url TEXT, aeoCompetitors TEXT,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SiteContextSection (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '', updatedBy TEXT NOT NULL DEFAULT 'user',
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX siteId_key ON SiteContextSection (siteId, key)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SiteKeyPage (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, url TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'other',
    topic TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', updatedBy TEXT NOT NULL DEFAULT 'user',
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX siteId_url ON SiteKeyPage (siteId, url)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE SiteResearchLog (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, entryDate TEXT NOT NULL,
    summary TEXT NOT NULL, createdBy TEXT NOT NULL DEFAULT 'user',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test("pure: normalizeKeyPageUrl folds /path and absolute URL onto one identity", async () => {
  const { normalizeKeyPageUrl } = await import("./store");
  assert.equal(normalizeKeyPageUrl("/pricing", "example.com"), "example.com/pricing");
  assert.equal(normalizeKeyPageUrl("/pricing/", "example.com"), "example.com/pricing");
  assert.equal(normalizeKeyPageUrl("https://www.example.com/pricing", ""), "example.com/pricing");
  assert.equal(normalizeKeyPageUrl("https://example.com/pricing?x=1", ""), "example.com/pricing?x=1");
  assert.equal(normalizeKeyPageUrl("not a url at all", "example.com"), "example.com/not a url at all");
  assert.equal(normalizeKeyPageUrl("", "example.com"), "");
});

test("get: empty context names its missing sections", async () => {
  const { getSiteContext } = await import("./store");
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s1', 'u1', 'https://example.com/')`);
  const ctx = await getSiteContext("s1");
  assert.equal(ctx.siteDomain, "example.com");
  assert.deepEqual(ctx.missingSections, ["business_overview", "current_goal", "positioning", "writing_preferences"]);
  assert.equal(ctx.researchLog.length, 0);
});

test("apply: sections set, custom section slugify + delete-on-empty, unknown keys skip", async () => {
  const { applyContextUpdates, getSiteContext } = await import("./store");

  let r = await applyContextUpdates("s1", [
    { section: "positioning", content: "The calm SEO tool for operators." },
    { section: "Not A Section", content: "x" },
  ], "mcp");
  assert.equal(r.applied, 1);
  assert.equal(r.skipped.length, 1);

  r = await applyContextUpdates("s1", [
    { section: "custom:Roadmap Notes", title: "Roadmap", content: "v2 coming" },
  ], "user");
  assert.equal(r.applied, 1);
  const ctx = await getSiteContext("s1");
  const custom = ctx.sections.find(s => s.key.startsWith("custom:"));
  assert.ok(custom, "custom section created");
  assert.equal(custom.title, "Roadmap");
  assert.equal(custom.key, "custom:roadmap-notes");
  assert.equal(ctx.missingSections.includes("positioning"), false);
  assert.equal(ctx.sections.find(s => s.key === "positioning")!.updatedBy, "mcp");

  // Empty content on a custom section deletes it; on a typed section it means "missing" again.
  r = await applyContextUpdates("s1", [{ section: "custom:roadmap-notes", title: "Roadmap", content: "" }], "user");
  assert.equal(r.applied, 1);
  r = await applyContextUpdates("s1", [{ section: "positioning", content: "" }], "user");
  assert.equal(r.applied, 1);
  const after = await getSiteContext("s1");
  assert.equal(after.sections.find(s => s.key.startsWith("custom:")), undefined);
  assert.equal(after.missingSections.includes("positioning"), true);
});

test("apply: competitors upsert into the AEO list, capped, removable", async () => {
  const { applyContextUpdates, getSiteContext } = await import("./store");
  const { prisma: p } = await import("../prisma");

  let r = await applyContextUpdates("s1", [
    { addCompetitors: [{ name: "Rival One", domain: "https://www.rivalone.com/", notes: "strong on comparisons" }] },
  ], "mcp");
  assert.equal(r.applied, 1);
  let ctx = await getSiteContext("s1");
  assert.equal(ctx.competitors.length, 1);
  assert.equal(ctx.competitors[0].domain, "rivalone.com"); // normalized
  assert.equal(ctx.competitors[0].notes, "strong on comparisons");

  // Same domain arrives with a new name → upsert, not a second row.
  r = await applyContextUpdates("s1", [
    { addCompetitors: [{ name: "Rival 1", domain: "rivalone.com" }] },
  ], "mcp");
  ctx = await getSiteContext("s1");
  assert.equal(ctx.competitors.length, 1);
  assert.equal(ctx.competitors[0].name, "Rival 1");

  // The cap mirrors the AEO tracker's (10); the 11th is skipped with a reason.
  for (let i = 0; i < 12; i++) {
    await applyContextUpdates("s1", [{ addCompetitors: [{ name: `C${i}`, domain: `c${i}.com` }] }], "mcp");
  }
  ctx = await getSiteContext("s1");
  assert.equal(ctx.competitors.length, 10);

  r = await applyContextUpdates("s1", [{ removeCompetitors: ["rivalone.com"] }], "user");
  assert.equal(r.applied, 1);
  ctx = await getSiteContext("s1");
  assert.equal(ctx.competitors.find(c => c.domain === "rivalone.com"), undefined);
  // The list really lives on Site.aeoCompetitors — the AEO tracker's store of record.
  const site = await p.site.findUnique({ where: { id: "s1" }, select: { aeoCompetitors: true } });
  assert.equal(JSON.parse(site!.aeoCompetitors ?? "[]").length, 9);
});

test("apply: key pages upsert by url, /path and absolute meet on one row", async () => {
  const { applyContextUpdates, getSiteContext } = await import("./store");
  await applyContextUpdates("s1", [
    { addKeyPages: [{ url: "/money", role: "money", topic: "best seo tool" }] },
  ], "user");
  let r = await applyContextUpdates("s1", [
    { addKeyPages: [{ url: "https://example.com/money", role: "hub", topic: "same row" }] },
  ], "mcp");
  assert.equal(r.applied, 1);
  const ctx = await getSiteContext("s1");
  assert.equal(ctx.keyPages.length, 1);
  assert.equal(ctx.keyPages[0].role, "hub"); // second write updated, not duplicated
  assert.equal(ctx.keyPages[0].url, "example.com/money");

  r = await applyContextUpdates("s1", [{ removeKeyPages: ["/money"] }], "user");
  assert.equal((await getSiteContext("s1")).keyPages.length, 0);
});

test("apply: research log appends with a server date, prunes past 90 days, batch skips nothing on one bad op", async () => {
  const { applyContextUpdates, getSiteContext } = await import("./store");
  const { prisma: p } = await import("../prisma");

  let r = await applyContextUpdates("s1", [
    { appendResearchLog: { summary: "Keyword research: seed \"x\". Verdict: 3 reach." } },
    { nonsense: true },
  ], "mcp");
  assert.equal(r.applied, 1);
  assert.equal(r.skipped.length, 1); // the bad op skipped, the log entry landed

  let ctx = await getSiteContext("s1");
  assert.match(ctx.researchLog[0].summary, /Keyword research/);
  assert.match(ctx.researchLog[0].entryDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ctx.researchLog[0].createdBy, "mcp");

  // A stale entry (planted by hand) is pruned by the next append.
  await p.$executeRawUnsafe(
    `INSERT INTO SiteResearchLog (id, siteId, entryDate, summary, createdBy, createdAt)
     VALUES ('old', 's1', '2020-01-01', 'ancient', 'user', datetime('now', '-120 days'))`,
  );
  await applyContextUpdates("s1", [{ appendResearchLog: { summary: "another entry" } }], "user");
  ctx = await getSiteContext("s1");
  assert.equal(ctx.researchLog.find(e => e.id === "old"), undefined);
});

test("render: the markdown digest names gaps and renders every part", async () => {
  const { getSiteContext, renderContextMarkdown, applyContextUpdates } = await import("./store");
  await applyContextUpdates("s1", [
    { section: "business_overview", content: "Casino affiliate portfolio, Greece-focused." },
    { addCompetitors: [{ name: "Rival", domain: "rival.com" }] },
  ], "user");
  const md = renderContextMarkdown(await getSiteContext("s1"));
  assert.match(md, /# Site context: example.com/);
  assert.match(md, /Casino affiliate portfolio/);
  assert.match(md, /Current goal\n_\(empty\)_/);
  assert.match(md, /Rival \(rival\.com\)/);
  assert.match(md, /Missing sections: current_goal/);
});
