import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preset CRUD + run-now against a scratch sqlite database (the setup run.test.ts uses):
// DATABASE_URL must exist before ../prisma is imported, hence dynamic imports throughout.
// The fire path runs with kick:false — the scan row is created and the background runner is
// NOT started, so no SERP provider is ever contacted; the runner itself has its own tests.
// A serper key is seeded so createAndRunGridScan's creds gate passes (the key is only read
// from the DB, never used — nothing runs).

const dir = mkdtempSync(join(tmpdir(), "opengsc-gridpreset-"));
type Db = Awaited<typeof import("../prisma")>["prisma"];
let prisma: Db;

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT, url TEXT, archivedAt DATETIME, hidden INTEGER NOT NULL DEFAULT 0)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE User (id TEXT PRIMARY KEY, seoSettings TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE LocalProfile (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL UNIQUE, name TEXT NOT NULL, country TEXT NOT NULL DEFAULT '',
    lat REAL, lng REAL
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE GridScan (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, keyword TEXT NOT NULL,
    centerLat REAL NOT NULL, centerLng REAL NOT NULL, gridSize INTEGER NOT NULL,
    radiusKm REAL NOT NULL, provider TEXT NOT NULL, depth INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
    points TEXT NOT NULL, presetId TEXT, hl TEXT NOT NULL DEFAULT '',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE GridPreset (
    id TEXT PRIMARY KEY, siteId TEXT NOT NULL, name TEXT NOT NULL, keyword TEXT NOT NULL,
    centerLat REAL NOT NULL, centerLng REAL NOT NULL, gridSize INTEGER NOT NULL,
    radiusKm REAL NOT NULL, hl TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL DEFAULT '',
    lastFireAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

/** u1 has a serper key (creation passes the creds gate); u3 has none. */
async function seed() {
  // The settings JSON rides inside a single-quoted SQL literal (inner double quotes are fine);
  // single quotes inside, were there any, would need doubling.
  const settings = JSON.stringify({ seoKey_serper: "test-key" }).replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s1', 'u1', 'https://www.example-tavern.gr/')`);
  await prisma.$executeRawUnsafe(`INSERT INTO User (id, seoSettings) VALUES ('u1', '${settings}')`);
  await prisma.$executeRawUnsafe(`INSERT INTO User (id, seoSettings) VALUES ('u3', NULL)`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO LocalProfile (id, siteId, name, country, lat, lng) VALUES ('lp1', 's1', 'Example Tavern', 'GR', 40.5197, 22.9709)`,
  );
}

const VALID: Parameters<typeof import("./preset").validateGridPresetInput>[0] = {
  name: "SKG airport", keyword: "thessaloniki airport transfer",
  centerLat: 40.5197, centerLng: 22.9709, gridSize: 5, radiusKm: 2, hl: "", schedule: "",
};

test("validateGridPresetInput: the accepted shape and every refusal", async () => {
  const { validateGridPresetInput } = await import("./preset");
  assert.equal(validateGridPresetInput(VALID), null);
  assert.equal(validateGridPresetInput({ ...VALID, name: "  " }), "name_required");
  assert.equal(validateGridPresetInput({ ...VALID, keyword: "" }), "keyword_required");
  assert.equal(validateGridPresetInput({ ...VALID, gridSize: 4 }), "grid_size_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, radiusKm: 0.05 }), "radius_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, radiusKm: 101 }), "radius_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, centerLat: 91 }), "center_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, centerLng: -181 }), "center_invalid");
  // hl: "" and 2-letter codes only — "ell"/"en-US" are typos, not languages.
  assert.equal(validateGridPresetInput({ ...VALID, hl: "ell" }), "hl_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, hl: "en-US" }), "hl_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, hl: "en" }), null);
  // schedule: "" or a VALID 5-field cron — the same validator the scheduler parses with.
  assert.equal(validateGridPresetInput({ ...VALID, schedule: "not cron" }), "schedule_invalid");
  assert.equal(validateGridPresetInput({ ...VALID, schedule: "0 6 * * *" }), null);
  assert.equal(validateGridPresetInput({ ...VALID, schedule: "0 6 * * 1" }), null);
});

test("resolveHl chain: explicit wins → profile country → us default (R+ §7.6-5)", async () => {
  const { resolveHl } = await import("./run");
  // Tourists search in EN/RU/DE while the profile country stays GR — explicit wins.
  assert.equal(resolveHl("ru", "GR"), "ru");
  assert.equal(resolveHl("EN", "GR"), "en"); // normalized
  // "" falls back to today's behaviour: the language of the profile country.
  assert.equal(resolveHl("", "GR"), "el");
  assert.equal(resolveHl("", "DE"), "de");
  // No profile country stated → gl "us" → en. Never a guess beyond the documented chain.
  assert.equal(resolveHl("", null), "en");
  assert.equal(resolveHl("", "XX"), "en");
  assert.equal(resolveHl(undefined, "GR"), "el");
});

test("runGridPreset chains the scan to the preset and resolves hl from the profile country", async () => {
  await seed();
  const { createGridPreset, runGridPreset } = await import("./preset");
  const created = await createGridPreset("u1", "s1", { ...VALID, hl: "" });
  assert.ok(created.ok, "preset creation failed");

  const fired = await runGridPreset("u1", created.preset.id, { kick: false });
  assert.ok(fired.ok && fired.result.ok, `fire failed: ${JSON.stringify(fired)}`);

  const scan = await prisma.gridScan.findFirst({ where: { presetId: created.preset.id } });
  assert.ok(scan, "no scan chained to the preset");
  assert.equal(scan.keyword, VALID.keyword);
  assert.equal(scan.centerLat, VALID.centerLat);
  assert.equal(scan.gridSize, VALID.gridSize);
  assert.equal(scan.provider, "serper");
  assert.equal(scan.status, "queued"); // kick:false — the row exists, the runner was not started
  // The hl the SERP will run with, stored resolved: "" + GR profile → el.
  assert.equal(scan.hl, "el");
  assert.equal(fired.ok && fired.result.ok ? fired.result.queryCount : 0, 25);
});

test("runGridPreset with an explicit hl: the preset's language beats the profile country", async () => {
  const { createGridPreset, runGridPreset } = await import("./preset");
  const created = await createGridPreset("u1", "s1", { ...VALID, name: "SKG EN", hl: "en" });
  assert.ok(created.ok);
  const fired = await runGridPreset("u1", created.preset.id, { kick: false });
  assert.ok(fired.ok && fired.result.ok);
  const scan = await prisma.gridScan.findFirst({ where: { presetId: created.preset.id } });
  assert.ok(scan);
  assert.equal(scan.hl, "en"); // not "el" — the whole point of the field
});

test("listGridPresets: dynamics oldest-first, manual scans excluded, summaries computed", async () => {
  const { createGridPreset, listGridPresets } = await import("./preset");
  const created = await createGridPreset("u1", "s1", { ...VALID, name: "series", schedule: "0 6 * * *" });
  assert.ok(created.ok);

  // Two preset scans (a finished one with real points, a running one empty) + a manual one-off.
  await prisma.gridScan.create({
    data: {
      siteId: "s1", keyword: VALID.keyword, centerLat: VALID.centerLat, centerLng: VALID.centerLng,
      gridSize: 3, radiusKm: 2, provider: "serper", depth: 20, status: "done", points: JSON.stringify([
        { row: 0, col: 0, lat: 1, lng: 1, position: 4, localPack: 1, businessName: "A" },
        { row: 0, col: 1, lat: 1, lng: 1, position: null, localPack: null, businessName: null },
      ]),
      presetId: created.preset.id, hl: "el", createdAt: new Date("2026-03-09T06:30:00Z"),
    },
  });
  await prisma.gridScan.create({
    data: {
      siteId: "s1", keyword: VALID.keyword, centerLat: VALID.centerLat, centerLng: VALID.centerLng,
      gridSize: 3, radiusKm: 2, provider: "serper", depth: 20, status: "running", points: "[]",
      presetId: created.preset.id, hl: "el", createdAt: new Date("2026-03-10T06:30:00Z"),
    },
  });
  await prisma.gridScan.create({
    data: {
      siteId: "s1", keyword: "manual one-off", centerLat: VALID.centerLat, centerLng: VALID.centerLng,
      gridSize: 3, radiusKm: 2, provider: "serper", depth: 20, status: "done", points: "[]", hl: "el",
    },
  });

  const presets = await listGridPresets("u1", "s1");
  const p = presets.find(x => x.id === created.preset.id);
  assert.ok(p, "preset missing from the list");
  assert.equal(p.scans.length, 2); // the manual scan is not part of the series
  // Oldest first — the order a dynamics chart plots in.
  assert.ok(p.scans[0].createdAt < p.scans[1].createdAt, "series not oldest-first");
  assert.equal(p.scans[0].status, "done");
  assert.equal(p.scans[0].summary.total, 2);
  assert.equal(p.scans[0].summary.inPack, 1);
  assert.equal(p.scans[0].summary.avgPosition, 1); // pack place 1 outranks the organic 4
  assert.equal(p.scans[1].status, "running");
  assert.equal(p.scans[1].summary.total, 0);
});

test("deleteGridPreset removes the configuration; its scans survive as history", async () => {
  const { createGridPreset, deleteGridPreset } = await import("./preset");
  const { listGridScans } = await import("./run");
  const created = await createGridPreset("u1", "s1", { ...VALID, name: "to delete" });
  assert.ok(created.ok);
  await prisma.gridScan.create({
    data: {
      siteId: "s1", keyword: "survivor", centerLat: 0, centerLng: 0, gridSize: 3, radiusKm: 1,
      provider: "serper", depth: 20, status: "done", points: "[]", presetId: created.preset.id, hl: "el",
    },
  });

  assert.equal(await deleteGridPreset("u1", created.preset.id), true);
  assert.equal(await prisma.gridPreset.findUnique({ where: { id: created.preset.id } }), null, "preset row not deleted");
  // The scan survives (schema: SetNull on a real db) and stays in the plain history list.
  const scans = await listGridScans("u1", "s1");
  assert.ok(scans.some(s => s.keyword === "survivor"), "the preset's scan vanished from history");
  // Ownership: another workspace's id is "not found", never deleted.
  assert.equal(await deleteGridPreset("u3", "nope"), false);
});

test("runGridPreset: no SERP key → refused BEFORE any row exists; foreign preset → not found", async () => {
  const { runGridPreset } = await import("./preset");
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s3', 'u3', 'https://other.example/')`);
  await prisma.gridPreset.create({
    data: {
      siteId: "s3", name: "other workspace", keyword: "x", centerLat: 0, centerLng: 0,
      gridSize: 3, radiusKm: 1,
    },
  });
  const preset3 = await prisma.gridPreset.findFirst({ where: { siteId: "s3" } });
  assert.ok(preset3);

  // u3 owns s3 but has no SERP key: the fire is refused and no scan row appears.
  const noKey = await runGridPreset("u3", preset3.id, { kick: false });
  assert.ok(noKey.ok && !noKey.result.ok);
  assert.ok(noKey.ok && !noKey.result.ok && noKey.result.error === "no_serp_key");
  assert.equal(await prisma.gridScan.count({ where: { siteId: "s3" } }), 0);

  // u1 asking for u3's preset: not found (scoped through site ownership).
  const foreign = await runGridPreset("u1", preset3.id, { kick: false });
  assert.ok(!foreign.ok && foreign.error === "preset_not_found");
});
