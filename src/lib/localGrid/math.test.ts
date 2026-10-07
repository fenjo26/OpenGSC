import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_SIZES,
  KM_PER_DEGREE_LAT,
  estimateQueryCount,
  generateGridPoints,
  isGridSize,
  kmPerDegreeLng,
  validateGridParams,
} from "./math";

const close = (actual: number, expected: number, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} ≈ ${expected} (±${tol})`);

test("3×3 at radius 2 km: corners at ±2 km, centre on the business", () => {
  const pts = generateGridPoints({ centerLat: 40.5197, centerLng: 22.9709, gridSize: 3, radiusKm: 2 });
  assert.equal(pts.length, 9);
  const at = (row: number, col: number) => pts.find(p => p.row === row && p.col === col)!;
  for (const p of pts) assert.ok(p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3);

  // Centre point sits exactly on the given coordinates.
  const c = at(1, 1);
  close(c.lat, 40.5197);
  close(c.lng, 22.9709);

  // ±2 km in latitude ≈ ±0.01798° (2 / 111.32), independent of where on Earth we are.
  close(at(0, 1).lat, 40.5197 + 2 / KM_PER_DEGREE_LAT, 1e-9); // north edge
  close(at(2, 1).lat, 40.5197 - 2 / KM_PER_DEGREE_LAT, 1e-9); // south edge

  // Longitude degrees are scaled by cos(lat): 2 km east at this latitude.
  const scale = kmPerDegreeLng(40.5197);
  close(at(1, 2).lng, 22.9709 + 2 / scale, 1e-9); // east edge
  close(at(1, 0).lng, 22.9709 - 2 / scale, 1e-9); // west edge

  // Corners carry BOTH offsets — a square grid, not two independent axes.
  close(at(0, 0).lat, 40.5197 + 2 / KM_PER_DEGREE_LAT, 1e-9);
  close(at(0, 0).lng, 22.9709 - 2 / scale, 1e-9);
  close(at(2, 2).lat, 40.5197 - 2 / KM_PER_DEGREE_LAT, 1e-9);
  close(at(2, 2).lng, 22.9709 + 2 / scale, 1e-9);

  // Row 0 is the north (higher latitude) edge — the grid renders in map orientation.
  assert.ok(at(0, 0).lat > at(2, 0).lat);
});

test("odd sizes keep a true centre; even and non-grid sizes are refused", () => {
  for (const size of GRID_SIZES) {
    const pts = generateGridPoints({ centerLat: 10, centerLng: 20, gridSize: size, radiusKm: 5 });
    assert.equal(pts.length, size * size);
    const mid = (size - 1) / 2;
    const centre = pts.find(p => p.row === mid && p.col === mid)!;
    close(centre.lat, 10, 1e-12);
    close(centre.lng, 20, 1e-12);
  }
  assert.equal(isGridSize(4), false); // even → two "centre" cells, no point on the business
  assert.equal(isGridSize(9), false);
  assert.throws(() => generateGridPoints({ centerLat: 10, centerLng: 20, gridSize: 4, radiusKm: 5 }), /grid_size_invalid/);
  assert.throws(() => generateGridPoints({ centerLat: 10, centerLng: 20, gridSize: 7, radiusKm: 0 }), /radius_invalid/);
  assert.throws(() => generateGridPoints({ centerLat: 10, centerLng: 20, gridSize: 7, radiusKm: -1 }), /radius_invalid/);
  assert.throws(() => validateGridParams({ centerLat: 91, centerLng: 0, gridSize: 3, radiusKm: 1 }), /center_lat_invalid/);
  assert.throws(() => validateGridParams({ centerLat: 0, centerLng: 181, gridSize: 3, radiusKm: 1 }), /center_lng_invalid/);
  assert.throws(() => validateGridParams({ centerLat: NaN, centerLng: 0, gridSize: 3, radiusKm: 1 }), /center_lat_invalid/);
  assert.doesNotThrow(() => validateGridParams({ centerLat: -90, centerLng: 180, gridSize: 7, radiusKm: 0.1 }));
});

test("5×5 ring spacing: neighbours one radius-half apart, outer ring at the radius", () => {
  const pts = generateGridPoints({ centerLat: 0, centerLng: 0, gridSize: 5, radiusKm: 10 });
  const at = (row: number, col: number) => pts.find(p => p.row === row && p.col === col)!;
  // At the equator lng scale = lat scale, so both axes read in the same degrees.
  close(at(0, 2).lat, 10 / KM_PER_DEGREE_LAT, 1e-9);
  close(at(1, 2).lat, 5 / KM_PER_DEGREE_LAT, 1e-9); // inner ring at half the radius
  close(at(2, 3).lng, 5 / KM_PER_DEGREE_LAT, 1e-6); // equator: cos(0) = 1
});

test("estimateQueryCount is gridSize², the whole cost of a scan", () => {
  assert.equal(estimateQueryCount(3), 9);
  assert.equal(estimateQueryCount(5), 25);
  assert.equal(estimateQueryCount(7), 49);
});

test("high latitude shrinks the longitude scale (cos effect)", () => {
  assert.ok(kmPerDegreeLng(60) < kmPerDegreeLng(40));
  close(kmPerDegreeLng(0), KM_PER_DEGREE_LAT, 1e-12);
  // A 2 km step east at 60° is ~2° of longitude — without the scale the grid would be squashed.
  const pts = generateGridPoints({ centerLat: 60, centerLng: 5, gridSize: 3, radiusKm: 2 });
  close(pts.find(p => p.row === 1 && p.col === 2)!.lng, 5 + 2 / kmPerDegreeLng(60), 1e-9);
});
