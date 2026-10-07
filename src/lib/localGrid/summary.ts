// Pure geo-grid shapes and summary math, split out of run.ts so client components (GridCard)
// can import them without dragging run.ts's server imports — prisma → better-sqlite3 — into the
// browser bundle. run.ts re-exports everything here, so server-side imports are unchanged.

/** One cell of a scan, as stored in GridScan.points (JSON) and returned to the UI/MCP. */
export interface GridScanPoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
  /** Organic best position for the site host at this point; null = not found in depth. */
  position: number | null;
  /** Our place in the map pack, 1..3; null = not in the pack. Separate from `position` (CONTRACT §0.2). */
  localPack: number | null;
  /** The matched pack entry's title — what Google showed, not what our profile says. */
  businessName: string | null;
  /** This point's check failed; the scan continues (isolation, not abort). */
  error?: string;
}

/** GridScan as the API and MCP return it: the row with `points` parsed out of its JSON string. */
export interface GridScanData {
  id: string;
  siteId: string;
  keyword: string;
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusKm: number;
  provider: string;
  depth: number;
  status: "queued" | "running" | "done" | "error";
  error: string;
  points: GridScanPoint[];
  /** The answer language the SERP actually ran with (resolved at creation; "" only on pre-R+ rows). */
  hl: string;
  /** Which preset fired this scan; null = a manual one-off run. */
  presetId: string | null;
  createdAt: string;
}

export interface GridScanSummary {
  total: number;
  answered: number;
  errored: number;
  inPack: number;
  /** Mean of (pack place when in the pack, else organic position) over found points; null = nothing found. */
  avgPosition: number | null;
  /** Share of ANSWERED points that hold a pack place, 0..1; null = nothing answered yet. */
  inPackShare: number | null;
}

/** The rank a cell displays: the pack place outranks the organic number it replaces on the map. */
export function pointRank(p: GridScanPoint): number | null {
  return p.localPack ?? p.position ?? null;
}

export function summarizePoints(points: GridScanPoint[]): GridScanSummary {
  const errored = points.filter(p => p.error).length;
  const answered = points.length - errored;
  const ranks: number[] = [];
  for (const p of points) {
    if (p.error) continue;
    const rank = pointRank(p);
    if (rank !== null) ranks.push(rank);
  }
  const inPack = points.filter(p => !p.error && p.localPack !== null).length;
  return {
    total: points.length,
    answered,
    errored,
    inPack,
    avgPosition: ranks.length ? Math.round((ranks.reduce((a, b) => a + (b ?? 0), 0) / ranks.length) * 10) / 10 : null,
    inPackShare: answered > 0 ? Math.round((inPack / answered) * 1000) / 1000 : null,
  };
}

