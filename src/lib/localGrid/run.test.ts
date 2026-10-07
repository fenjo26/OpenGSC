import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GridScanPoint } from "./run";

// The geo-grid runner against a scratch sqlite database, the setup magiclinks/tracking.test.ts
// uses: DATABASE_URL must exist before ../prisma (imported transitively by ./run, which pulls in
// lib/rank.ts → the SERP stack) is imported, hence the dynamic imports. The per-point SERP call
// is injected — the same dependency-injection shape rankFallback.test.ts blesses — so no provider
// is ever contacted; prisma itself is real, which is what these tests exercise.

const dir = mkdtempSync(join(tmpdir(), "opengsc-grid-"));
// The real client type (test tables mirror only the columns the runner touches, but create/
// findUnique/update must type-check exactly as they do in production code — hence no `any`).
type Db = Awaited<typeof import("../prisma")>["prisma"];
let prisma: Db;

before(async () => {
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  ({ prisma } = await import("../prisma"));
  // Only the columns the runner reads/writes; Prisma's create() fills the defaulted rest.
  await prisma.$executeRawUnsafe(`CREATE TABLE Site (id TEXT PRIMARY KEY, userId TEXT, url TEXT)`);
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
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

// A User with no seoSettings → getUserSerpCreds answers null → the default scanPoint path fails
// with no_serp_key. Tests that inject a scanPoint never reach creds resolution at all.
// Seeded with raw SQL: the scratch tables carry only the columns the runner reads, and Prisma's
// create() would emit the full column list of the real models.
async function seed(opts: { gridScan?: boolean } = {}) {
  const db = prisma;
  await db.$executeRawUnsafe(`INSERT INTO Site (id, userId, url) VALUES ('s1', 'u1', 'https://www.example-tavern.gr/')`);
  await db.$executeRawUnsafe(`INSERT INTO User (id, seoSettings) VALUES ('u1', NULL)`);
  await db.$executeRawUnsafe(
    `INSERT INTO LocalProfile (siteId, name, country, lat, lng) VALUES ('s1', 'Example Tavern', 'GR', 40.5197, 22.9709)`,
  );
  if (opts.gridScan) {
    await db.gridScan.create({
      data: {
        id: "g1", siteId: "s1", keyword: "taverna", centerLat: 40.5197, centerLng: 22.9709,
        gridSize: 3, radiusKm: 2, provider: "serper", depth: 20, points: "[]",
      },
    });
  }
}

/** The stored points JSON, typed — the runner's own contract shape is what these tests assert. */
const readPoints = (raw: string): GridScanPoint[] => JSON.parse(raw) as GridScanPoint[];

const noSleep = async () => {};
const freshScanPoint = (answerFor?: (row: number, col: number) => { error?: string } | undefined) => {
  const calls: { lat: number; lng: number }[] = [];
  // Points-count snapshots taken at each call — the proof the runner persists progressively.
  const seenPointsCounts: number[] = [];
  const scanPoint = async (p: { lat: number; lng: number }) => {
    calls.push(p);
    const grid = (await prisma.gridScan.findUnique({ where: { id: "g1" } }))!;
    seenPointsCounts.push(JSON.parse(grid.points).length);
    const row = Math.floor((calls.length - 1) / 3);
    const col = (calls.length - 1) % 3;
    const err = answerFor?.(row, col)?.error;
    if (err) return { position: null, localPack: null, businessName: null, error: err };
    // Deterministic per-cell answer: pack place 1..3 when found, organic position otherwise.
    const inPack = (row + col) % 2 === 0;
    return inPack
      ? { position: 4, localPack: ((row + col) % 3) + 1, businessName: "Example Tavern" }
      : { position: 7 + row, localPack: null, businessName: null };
  };
  return { scanPoint, calls, seenPointsCounts };
};

test("sequential points persist progressively; done status; points JSON shape", async () => {
  await seed({ gridScan: true });
  const { runGridScan } = await import("./run");
  const { scanPoint, calls, seenPointsCounts } = freshScanPoint();

  await runGridScan("g1", { scanPoint, sleep: noSleep });

  // 9 points, one call each — strictly sequential (progressive snapshots saw the array grow 0→8).
  assert.equal(calls.length, 9);
  assert.deepEqual(seenPointsCounts, [0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const row = await prisma.gridScan.findUnique({ where: { id: "g1" } });
  assert.ok(row, "scan row missing");
  assert.equal(row.status, "done");
  assert.equal(row.error, "");
  const points = readPoints(row.points);
  assert.equal(points.length, 9);
  // Geometry rides along: row 0 = north (higher lat), col 0 = west (lower lng).
  const north = points.find(p => p.row === 0 && p.col === 1)!;
  const south = points.find(p => p.row === 2 && p.col === 1)!;
  assert.ok(north.lat > south.lat);
  // The centre cell is exactly the scan centre.
  const centre = points.find(p => p.row === 1 && p.col === 1)!;
  assert.ok(Math.abs(centre.lat - 40.5197) < 1e-9 && Math.abs(centre.lng - 22.9709) < 1e-9);
  // Every cell carries the full contract shape.
  for (const p of points) {
    for (const k of ["row", "col", "lat", "lng", "position", "localPack", "businessName"]) assert.ok(k in p, `${k} missing`);
    assert.ok(!("error" in p));
  }
  // A pack answer keeps organic and pack SEPARATE (CONTRACT §0.2): position 4, localPack 1..3.
  const packCell = points.find(p => p.localPack !== null)!;
  assert.equal(packCell.position, 4);
  assert.equal(packCell.businessName, "Example Tavern");
  assert.ok(packCell.localPack !== null && packCell.localPack >= 1 && packCell.localPack <= 3);
  const organicCell = points.find(p => p.localPack === null)!;
  assert.equal(organicCell.businessName, null);
});

test("a failing point is isolated: its error is stored, the scan still finishes done", async () => {
  const { runGridScan } = await import("./run");
  const { scanPoint, calls } = freshScanPoint((row, col) => (row === 1 && col === 1 ? { error: "provider 503" } : undefined));

  await runGridScan("g1", { scanPoint, sleep: noSleep });

  assert.equal(calls.length, 9); // one bad point cost exactly one cell
  const row = await prisma.gridScan.findUnique({ where: { id: "g1" } });
  assert.ok(row, "scan row missing");
  assert.equal(row.status, "done");
  const points = readPoints(row.points);
  const bad = points.find(p => p.row === 1 && p.col === 1)!;
  assert.equal(bad.error, "provider 503");
  assert.equal(bad.position, null);
  assert.equal(bad.localPack, null);
  assert.equal(points.filter(p => !p.error).length, 8);
});

test("a throwing scanPoint (not a soft error) is caught per point too", async () => {
  const { runGridScan } = await import("./run");
  let n = 0;
  const scanPoint = async () => {
    n++;
    if (n === 1) throw new Error("boom");
    return { position: 2, localPack: null, businessName: null };
  };
  await runGridScan("g1", { scanPoint, sleep: noSleep });
  const row = await prisma.gridScan.findUnique({ where: { id: "g1" } });
  assert.ok(row, "scan row missing");
  assert.equal(row.status, "done");
  const points = readPoints(row.points);
  assert.equal(points.find(p => p.row === 0 && p.col === 0)!.error, "boom");
  assert.equal(points.filter(p => p.error).length, 1);
});

test("no creds → whole-run error BEFORE any point exists", async () => {
  // No injected scanPoint: the default path resolves creds, and the seeded user has none.
  const { runGridScan } = await import("./run");
  await prisma.gridScan.update({ where: { id: "g1" }, data: { status: "queued", points: "[]" } });
  await runGridScan("g1", { sleep: noSleep });
  const row = await prisma.gridScan.findUnique({ where: { id: "g1" } });
  assert.ok(row, "scan row missing");
  assert.equal(row.status, "error");
  assert.match(row.error, /no_serp_key/);
  assert.equal(readPoints(row.points).length, 0);
});

test("unknown scan id resolves silently (row deleted before the runner picked it up)", async () => {
  const { runGridScan } = await import("./run");
  await runGridScan("nope", { sleep: noSleep }); // must not reject
});

test("summarizePoints: avg rank, in-pack share, errors kept apart from not-found", async () => {
  const { summarizePoints } = await import("./run");
  const s = summarizePoints([
    { row: 0, col: 0, lat: 1, lng: 1, position: 4, localPack: 1, businessName: "A" }, // rank 1
    { row: 0, col: 1, lat: 1, lng: 1, position: 7, localPack: null, businessName: null }, // rank 7
    { row: 0, col: 2, lat: 1, lng: 1, position: null, localPack: null, businessName: null }, // not found
    { row: 1, col: 0, lat: 1, lng: 1, position: null, localPack: null, businessName: null, error: "503" }, // errored
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.answered, 3);
  assert.equal(s.errored, 1);
  assert.equal(s.inPack, 1);
  assert.equal(s.avgPosition, (1 + 7) / 2);
  assert.equal(s.inPackShare, Math.round((1 / 3) * 1000) / 1000);
  assert.equal(summarizePoints([]).avgPosition, null);
  assert.equal(summarizePoints([]).inPackShare, null);
});
