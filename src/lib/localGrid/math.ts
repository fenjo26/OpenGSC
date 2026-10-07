// GEO-GRID geometry (wave G) — pure math, no I/O, no Prisma: everything here is testable against
// known offsets without a provider or a database.
//
// The grid is the Local-Falcon-style scan: one keyword checked at N×N coordinate points spread
// over a square around the business, so the heatmap shows where the map pack actually reaches.
// The algorithm is ported from RosterSeo (packages/dataforseo/src/geo-grid-math.ts, MIT license):
// an equirectangular approximation — at city scale the error against a great-circle projection is
// metres, which is far below what a SERP geolocation can even resolve.

/** One point of the scan grid. row 0 is the NORTH edge, col 0 the WEST edge (map orientation). */
export interface GridPoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
}

/** Kilometres per degree of latitude, constant everywhere on Earth to ~0.4%. */
export const KM_PER_DEGREE_LAT = 111.32;

/** Grid sizes a scan accepts — odd, so there is always a true centre point on the business. */
export const GRID_SIZES = [3, 5, 7] as const;
export type GridSize = (typeof GRID_SIZES)[number];

export function isGridSize(v: number): v is GridSize {
  return (GRID_SIZES as readonly number[]).includes(v);
}

/** How many SERP queries a scan costs: one per point, gridSize² total. No hidden multipliers. */
export function estimateQueryCount(gridSize: number): number {
  return gridSize * gridSize;
}

/**
 * Validate the scan geometry. Thrown Errors (not result codes) because every caller — route,
 * MCP tool, runner — refuses the scan outright on a bad shape, and an exception cannot be
 * accidentally half-handled into a run with a broken grid.
 */
export function validateGridParams(p: { centerLat: number; centerLng: number; gridSize: number; radiusKm: number }): void {
  if (!isGridSize(p.gridSize)) {
    throw new Error(`grid_size_invalid: ${p.gridSize} (accepted: ${GRID_SIZES.join(", ")})`);
  }
  if (!Number.isFinite(p.radiusKm) || p.radiusKm <= 0) {
    throw new Error(`radius_invalid: ${p.radiusKm}`);
  }
  if (!Number.isFinite(p.centerLat) || Math.abs(p.centerLat) > 90) {
    throw new Error(`center_lat_invalid: ${p.centerLat}`);
  }
  if (!Number.isFinite(p.centerLng) || Math.abs(p.centerLng) > 180) {
    throw new Error(`center_lng_invalid: ${p.centerLng}`);
  }
}

/** Degrees of longitude per kilometre at this latitude — shrinks with cos(lat) towards the poles. */
export function kmPerDegreeLng(centerLat: number): number {
  return KM_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
}

/**
 * The N×N points of a scan. `radiusKm` is the distance from the centre to the outer RING along
 * each axis (schema comment: "centre → outer edge"), so the full grid spans 2×radiusKm per side.
 *
 * Offsets are (index − half) / half × radiusKm per axis, half = floor(gridSize / 2) — the ported
 * RosterSeo formulation, which places the centre point exactly on the business and the corners
 * exactly at ±radiusKm on both axes. Longitude degrees are scaled by cos(centerLat): at
 * Thessaloniki's latitude a kilometre east is ~28% more degrees than a kilometre north is.
 */
export function generateGridPoints(p: {
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusKm: number;
}): GridPoint[] {
  validateGridParams(p);
  const half = Math.floor(p.gridSize / 2);
  const lngScale = kmPerDegreeLng(p.centerLat);
  const points: GridPoint[] = [];
  for (let row = 0; row < p.gridSize; row++) {
    for (let col = 0; col < p.gridSize; col++) {
      const kmNorth = ((half - row) / half) * p.radiusKm; // row 0 = north edge
      const kmEast = ((col - half) / half) * p.radiusKm; // col 0 = west edge
      points.push({
        row,
        col,
        lat: p.centerLat + kmNorth / KM_PER_DEGREE_LAT,
        lng: p.centerLng + kmEast / lngScale,
      });
    }
  }
  return points;
}
