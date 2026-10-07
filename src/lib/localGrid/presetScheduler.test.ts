import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The scheduler's fire logic against a scratch sqlite database (the setup run.test.ts uses;
// DATABASE_URL before ../prisma, dynamic imports). The tick takes an injectable runScan, so
// the fire path stops right after the scan row is created — no runner, no SERP provider.
// Every test clears the tables first: a tick walks ALL scheduled presets, so leftovers from
// a previous test would fire here and break the counts. All times are UTC — the cron matcher
// evaluates UTC and so do these fixtures.

const dir = mkdtempSync(join(tmpdir(), "opengsc-grid_sched-"));
type Db = Awaited<typeof import("../prisma")>["prisma"];
let prisma: Db;

// 2026-03-10 is a Tuesday; 06:40Z — ten minutes inside a 06:30 cron window.
const T0 = Date.UTC(2026, 2, 10, 6, 40, 0);
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
/** 2026-03-DDT06:30:00Z — the moment a "30 6 * * *" expression fires. */
const fireAt = (day: number) => new Date(Date.UTC(2026, 2, day, 6, 30));

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT, url TEXT, archivedAt DATETIME, hidden INTEGER NOT NULL DEFAULT 0)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE User (id TEXT PRIMARY KEY, seoSettings TEXT)`);
  // The creation path reads a LocalProfile (country → hl default); an EMPTY table is the
  // "no profile stated" case: gl falls to "us", hl to "en" — the documented chain. The id
  // column exists because the model's findUnique goes through it.
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
  await prisma.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s1', 'u1', 'https://www.example-tavern.gr/')`);
  // serper key: creation's creds gate passes; the key is only read, never used. The JSON rides
  // inside a single-quoted SQL literal — inner double quotes are legal there.
  const settings = JSON.stringify({ seoKey_serper: "test-key" }).replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`INSERT INTO User (id, seoSettings) VALUES ('u1', '${settings}')`);
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function reset() {
  await prisma.$executeRawUnsafe("DELETE FROM GridScan");
  await prisma.$executeRawUnsafe("DELETE FROM GridPreset");
}

async function makePreset(opts: { id: string; schedule: string; lastFireAt?: Date | null }) {
  await prisma.gridPreset.create({
    data: {
      id: opts.id, siteId: "s1", name: opts.id, keyword: "taxi", centerLat: 40.5, centerLng: 22.9,
      gridSize: 3, radiusKm: 2, hl: "", schedule: opts.schedule,
      ...(opts.lastFireAt !== undefined ? { lastFireAt: opts.lastFireAt } : {}),
    },
  });
}

/** The injected runScan: records ids instead of running grids. */
const recorder = () => {
  const fired: string[] = [];
  return { fired, runScan: async (id: string) => { fired.push(id); } };
};

const scanCount = () => prisma.gridScan.count();
const preset = (id: string) => prisma.gridPreset.findUnique({ where: { id } });

test("first sighting adopts the marker WITHOUT firing (no retroactive scan)", async () => {
  await reset();
  await makePreset({ id: "p-first", schedule: "30 6 * * *" }); // daily 06:30 UTC
  const { fired, runScan } = recorder();
  const { gridPresetTick } = await import("./presetScheduler");

  await gridPresetTick(at(0), { runScan }); // 06:40 — the 06:30 window is live

  assert.equal(fired.length, 0, "fired on first sighting");
  assert.equal(await scanCount(), 0, "scan row created on first sighting");
  const p = await preset("p-first");
  assert.ok(p?.lastFireAt, "marker not adopted");
  assert.equal(p!.lastFireAt!.toISOString(), fireAt(10).toISOString());
});

test("a live window after the marker fires ONE chained scan; a re-tick does not double it", async () => {
  await reset();
  await makePreset({ id: "p-fire", schedule: "30 6 * * *", lastFireAt: fireAt(10) }); // marker = yesterday
  const { fired, runScan } = recorder();
  const { gridPresetTick } = await import("./presetScheduler");

  await gridPresetTick(at(DAY), { runScan }); // next day 06:40 — today's window is live
  assert.equal(fired.length, 1);
  assert.equal(await scanCount(), 1);
  const scan = await prisma.gridScan.findFirst({ where: { presetId: "p-fire" } });
  assert.ok(scan, "scan not chained to the preset");
  assert.equal(scan.hl, "en"); // no LocalProfile row → gl us → en (the documented chain)
  let p = await preset("p-fire");
  assert.equal(p!.lastFireAt!.toISOString(), fireAt(11).toISOString(), "marker not advanced");

  // Re-tick inside the same window: latestFire == lastFireAt → nothing new.
  await gridPresetTick(at(DAY + 10 * MIN), { runScan });
  assert.equal(fired.length, 1, "double fire inside one window");
  assert.equal(await scanCount(), 1);
});

test("a young scan in flight holds the fire; an abandoned one does not silence the preset", async () => {
  await reset();
  await makePreset({ id: "p-hold", schedule: "30 6 * * *", lastFireAt: fireAt(10) });
  const { fired, runScan } = recorder();
  const { gridPresetTick } = await import("./presetScheduler");

  // A grid for this preset is running (created 30 min before "now") — well inside the 2 h cap.
  const inFlight = await prisma.gridScan.create({
    data: {
      siteId: "s1", keyword: "taxi", centerLat: 40.5, centerLng: 22.9, gridSize: 3, radiusKm: 2,
      provider: "serper", depth: 20, status: "running", points: "[]", presetId: "p-hold", hl: "en",
      createdAt: at(DAY - 30 * MIN),
    },
  });
  await gridPresetTick(at(DAY), { runScan }); // the window is due but the preset is busy
  assert.equal(fired.length, 0, "fired on top of an in-flight scan");
  assert.equal(await scanCount(), 1); // only the in-flight row
  // The marker held back, so the window is NOT consumed — it catches up on a later tick.
  let p = await preset("p-hold");
  assert.equal(p!.lastFireAt!.toISOString(), fireAt(10).toISOString());

  // The row is now 2 h 40 min old — past the cap, i.e. abandoned (a restart left it), not busy.
  await prisma.gridScan.update({ where: { id: inFlight.id }, data: { createdAt: at(DAY - 160 * MIN) } });
  await gridPresetTick(at(DAY + 10 * MIN), { runScan });
  assert.equal(fired.length, 1, "a zombie running row silenced the preset forever");
  assert.equal(await scanCount(), 2);
  p = await preset("p-hold");
  assert.equal(p!.lastFireAt!.toISOString(), fireAt(11).toISOString());
});

test("downtime is a visible gap, not a back-fill: an aged-out window never fires", async () => {
  await reset();
  // Marker two days old; "now" is 08:10, so today's 06:30 fire is 100 minutes stale — outside
  // the 60-minute look-back it is deliberately missed (a run costs gridSize² queries).
  await makePreset({ id: "p-gap", schedule: "30 6 * * *", lastFireAt: fireAt(8) });
  const { fired, runScan } = recorder();
  const { gridPresetTick } = await import("./presetScheduler");

  await gridPresetTick(at(90 * MIN), { runScan }); // 08:10

  assert.equal(fired.length, 0, "back-filled a stale window");
  assert.equal(await scanCount(), 0);
  const p = await preset("p-gap");
  assert.equal(p!.lastFireAt!.toISOString(), fireAt(8).toISOString(), "marker moved without a scan");
});

test("a non-matching weekday and a manual preset never fire; the marker stays put", async () => {
  await reset();
  await makePreset({ id: "p-monday", schedule: "30 6 * * 1", lastFireAt: fireAt(9) }); // Mondays
  await makePreset({ id: "p-manual", schedule: "" });
  const { fired, runScan } = recorder();
  const { gridPresetTick } = await import("./presetScheduler");

  // 2026-03-11 is a Wednesday — no Monday window inside the look-back.
  await gridPresetTick(at(DAY + 2 * HOUR), { runScan });

  assert.equal(fired.length, 0);
  assert.equal(await scanCount(), 0);
  const manual = await preset("p-manual");
  assert.equal(manual!.lastFireAt, null, "manual preset was touched");
  const monday = await preset("p-monday");
  assert.equal(monday!.lastFireAt!.toISOString(), fireAt(9).toISOString());
});
