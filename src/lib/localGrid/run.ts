// GEO-GRID scan runner (wave G) — orchestrates the EXISTING rank-check path over a coordinate
// grid: one keyword, N×N points, each point a `runSerp` call geolocated to "lat,lng" (the same
// location contract TrackedKeyword.location documents in lib/rank.ts). No new providers, no AI.
//
// Persistence mirrors the AeoCheck/citations pattern: one row, points as JSON-in-row, rewritten
// after EVERY point so a polling UI shows partial results while the scan runs.
//
// The heavy lifting is imported, never re-implemented:
//  - getUserSerpCreds / localMatchNames from lib/rank.ts (the server-side creds snapshot and the
//    pack-matching name list);
//  - checkWithFallback / fallbackForLocation from lib/rankFallback.ts — a grid point gets the
//    same retry-then-fallback policy a tracked keyword gets;
//  - runSerp from lib/seo/serp.ts — the same transport `scan()` in rank.ts uses;
//  - matchLocalPack / supportsLocation from lib/seo/localPack.ts.

import { prisma } from "@/lib/prisma";
import { getUserSerpCreds, localMatchNames, type SerpCreds } from "@/lib/rank";
import { checkWithFallback, fallbackForLocation } from "@/lib/rankFallback";
import { runSerp } from "@/lib/seo/serp";
import { matchLocalPack, supportsLocation } from "@/lib/seo/localPack";
import { defaultLanguageFor } from "@/lib/seo/regions";
import { generateGridPoints, isGridSize } from "./math";

// A geo-grid answers "where does the map pack reach", which lives at the top of the SERP; organic
// depth 20 keeps every point one provider call (the pack is always above it). rank.ts's smart
// window does not apply: a grid point has no last position to window around, exactly like the
// first check of a brand-new keyword.
const GRID_SCAN_DEPTH = 20;

/** Politeness gap between points on metered providers — the same 800 ms checkSiteKeywords uses. */
const POINT_DELAY_MS = 800;

/** Cap on the stored keyword / per-point error — SQLite columns are cheap, bloat is not. */
const KEYWORD_MAX = 200;
const POINT_ERROR_MAX = 500;

// ─── row shapes ────────────────────────────────────────────────────────────────

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
  createdAt: string;
}

type GridScanRow = { id: string; siteId: string; keyword: string; centerLat: number; centerLng: number; gridSize: number; radiusKm: number; provider: string; depth: number; status: string; error: string; points: string; createdAt: Date };

function toData(row: GridScanRow): GridScanData {
  let points: GridScanPoint[] = [];
  try {
    const parsed = JSON.parse(row.points);
    if (Array.isArray(parsed)) points = parsed as GridScanPoint[];
  } catch { /* stored garbage degrades to "no points", never to a crashed route */ }
  return {
    id: row.id, siteId: row.siteId, keyword: row.keyword,
    centerLat: row.centerLat, centerLng: row.centerLng, gridSize: row.gridSize, radiusKm: row.radiusKm,
    provider: row.provider, depth: row.depth,
    status: (["queued", "running", "done", "error"] as const).includes(row.status as never) ? row.status as GridScanData["status"] : "error",
    error: row.error, points, createdAt: row.createdAt.toISOString(),
  };
}

// ─── summary (pure — the UI and the MCP tool render the same numbers) ──────────

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

// ─── the per-point SERP call (the ported shape of rank.ts's private scan()) ─────

// rank.ts keeps hostOf/matchesSite private; the rules are two lines each and its own comment says
// the localPack.ts copy must stay "the same rule lib/rank.ts applies" — mirrored here verbatim.
function hostOf(domain: string): string {
  let d = (domain || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");
  d = d.split("/")[0];
  return d.replace(/^www\./, "");
}

function matchesSite(resultDomain: string, siteHost: string): boolean {
  const r = (resultDomain || "").toLowerCase().replace(/^www\./, "");
  return r === siteHost || r.endsWith("." + siteHost);
}

/** What one grid point's check answers. */
export interface PointAnswer {
  position: number | null;
  localPack: number | null;
  businessName: string | null;
  error?: string;
}

/**
 * The default per-point check: `runSerp` geolocated to "lat,lng", wrapped in the rank tracker's
 * retry-then-fallback policy, then the pack matched with the site's host + business names.
 * Injected as `scanPoint` in tests; in production it is the only implementation.
 */
export function buildScanPoint(
  creds: SerpCreds,
  kw: { keyword: string; gl: string; hl: string; depth: number; siteHost: string; names: readonly string[] },
): (point: { lat: number; lng: number }) => Promise<PointAnswer> {
  return async (point) => {
    // The location contract from rank.ts: "" = country | city name | "lat,lng". A grid point is
    // always coordinates — that is the whole feature.
    const location = `${point.lat},${point.lng}`;
    const outcome = await checkWithFallback(async (provider) => {
      const c = provider === creds.provider ? creds : creds.fallback;
      if (!c) return { position: null, url: null, depth: kw.depth, error: `no_serp_key (${provider})`, provider };
      const serp = await runSerp(c.provider, c.apiKey, kw.keyword, {
        gl: kw.gl, hl: kw.hl, num: kw.depth,
        ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
        ...(c.configPreset ? { configPreset: c.configPreset } : {}),
        location,
      });
      if (serp.error) return { position: null, url: null, depth: kw.depth, error: serp.error, provider };
      const found = serp.results.find((r) => matchesSite(r.domain, kw.siteHost)) ?? null;
      return {
        position: found?.position ?? null,
        url: found?.url ?? null,
        depth: kw.depth,
        provider,
        ...(serp.localPack?.length ? { localPack: serp.localPack } : {}),
      };
    }, creds.provider, fallbackForLocation(creds.fallback?.provider, location));

    if (outcome.error) {
      return { position: null, localPack: null, businessName: null, error: outcome.error.slice(0, POINT_ERROR_MAX) };
    }
    const match = outcome.localPack?.length
      ? matchLocalPack(outcome.localPack, { host: kw.siteHost, names: kw.names })
      : null;
    return {
      position: outcome.position,
      localPack: match?.position ?? null,
      businessName: match?.title ?? null,
    };
  };
}

// ─── the runner ────────────────────────────────────────────────────────────────

export type ScanPointFn = (point: { lat: number; lng: number }, index: number) => Promise<PointAnswer>;

/**
 * Run one stored scan to completion. Sequential by design — a 7×7 grid is 49 queries, and a
 * personal A-Parser instance behind one proxy pool must not see them arrive in a burst.
 *
 * Status contract: queued → running → done | error. `error` (the column) is written ONLY when the
 * run as a whole failed before any point was answered (no creds, no site); a point that fails is
 * that point's `error` field, the scan still finishes — half a heatmap with honest holes beats no
 * heatmap. Never rejects: the API route fires it and forgets.
 */
export async function runGridScan(
  scanId: string,
  opts: { scanPoint?: ScanPointFn; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = async (error: string) => {
    try {
      await prisma.gridScan.update({ where: { id: scanId }, data: { status: "error", error: error.slice(0, 1000) } });
    } catch { /* row removed mid-run — nothing left to report on */ }
  };

  try {
    const scan = await prisma.gridScan.findUnique({
      where: { id: scanId },
      include: { site: { select: { id: true, url: true, userId: true } } },
    });
    // A row without its site is not a state the schema can produce (cascade delete); if it ever
    // appears the honest answer is an errored row, not a silent no-op.
    if (!scan || !scan.site) return await fail("scan_or_site_missing");

    const profile = await prisma.localProfile.findUnique({ where: { siteId: scan.siteId } }).catch(() => null);
    // Creds are resolved only on the default path — an injected scanPoint (tests) brings its own
    // provider and must be exercisable without a configured key.
    const creds = opts.scanPoint ? null : await getUserSerpCreds(scan.site.userId);
    if (!opts.scanPoint) {
      if (!creds) return await fail("no_serp_key — configure a SERP provider in Settings → SEO Tools");
      if (!supportsLocation(creds.provider)) {
        return await fail(`location_unsupported: ${creds.provider} takes no location parameter, so it cannot answer a grid point`);
      }
    }

    const siteHost = hostOf(scan.site.url);
    // The market the SERP is answered for: the business's own country when the profile states
    // one, "us" otherwise — gl only nudges the SERP, the geography itself is the explicit
    // scan centre, so this default never guesses WHERE the grid is.
    const gl = /^[a-z]{2}$/i.test(profile?.country ?? "") ? (profile!.country as string).toLowerCase() : "us";
    const scanPoint = opts.scanPoint ?? buildScanPoint(creds!, {
      keyword: scan.keyword,
      gl,
      hl: defaultLanguageFor(gl),
      depth: scan.depth,
      siteHost,
      names: localMatchNames(siteHost, profile?.name ? [profile.name] : []),
    });

    await prisma.gridScan.update({ where: { id: scanId }, data: { status: "running" } });

    const grid = generateGridPoints({
      centerLat: scan.centerLat, centerLng: scan.centerLng, gridSize: scan.gridSize, radiusKm: scan.radiusKm,
    });
    const points: GridScanPoint[] = [];
    for (let i = 0; i < grid.length; i++) {
      const p = grid[i];
      let answer: PointAnswer;
      try {
        answer = await scanPoint(p, i);
      } catch (e) {
        // One broken point (dead proxy for one request, provider hiccup) must not cost the
        // other 48 — the hole is visible as that cell's own error.
        answer = { position: null, localPack: null, businessName: null, error: String((e as Error)?.message ?? e).slice(0, POINT_ERROR_MAX) };
      }
      points.push({ row: p.row, col: p.col, lat: p.lat, lng: p.lng, ...answer });
      // Persist after EVERY point: the polling UI paints cells as they arrive.
      await prisma.gridScan.update({ where: { id: scanId }, data: { points: JSON.stringify(points) } });
      // A-Parser is the user's own instance (the transport paces itself); metered providers get
      // the same 800 ms gap checkSiteKeywords gives a keyword batch.
      if (i < grid.length - 1 && (!creds || creds.provider !== "aparser")) await sleep(POINT_DELAY_MS);
    }
    await prisma.gridScan.update({ where: { id: scanId }, data: { status: "done" } });
  } catch (e) {
    await fail(String((e as Error)?.message ?? e));
  }
}

// ─── creation + listing (shared by the API route and the MCP tool) ─────────────

export interface GridScanInput {
  keyword: string;
  gridSize: number;
  radiusKm: number;
  /** Overrides the profile centre; both must be present — a half-overridden centre is a typo. */
  centerLat?: number;
  centerLng?: number;
}

export type CreateGridScanProblem =
  | "site_not_found"
  | "keyword_required"
  | "grid_size_invalid"
  | "radius_invalid"
  | "center_invalid"
  | "profile_no_coords"
  | "no_serp_key"
  | "location_unsupported";

export const RADIUS_MIN_KM = 0.1;
export const RADIUS_MAX_KM = 100;

export type CreateGridScanResult =
  | { ok: true; scan: GridScanData; queryCount: number }
  | { ok: false; error: CreateGridScanProblem; hint?: string };

/**
 * Validate + create a scan row and kick the runner in the background (the seo-jobs
 * fire-and-forget shape: the route answers immediately, the row tells the truth later).
 *
 * The centre is NEVER guessed: explicit coordinates win, otherwise the LocalProfile's lat/lng,
 * otherwise an honest `profile_no_coords` asking the operator for one of the two.
 */
export async function createAndRunGridScan(userId: string, siteDbId: string, input: GridScanInput): Promise<CreateGridScanResult> {
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return { ok: false, error: "site_not_found" };

  const keyword = String(input.keyword ?? "").trim().slice(0, KEYWORD_MAX);
  if (!keyword) return { ok: false, error: "keyword_required" };
  const gridSize = Number(input.gridSize);
  if (!Number.isFinite(gridSize) || !isGridSize(gridSize)) {
    return { ok: false, error: "grid_size_invalid", hint: "Accepted grid sizes: 3, 5, 7." };
  }
  const radiusKm = Number(input.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm < RADIUS_MIN_KM || radiusKm > RADIUS_MAX_KM) {
    return { ok: false, error: "radius_invalid", hint: `Radius must be between ${RADIUS_MIN_KM} and ${RADIUS_MAX_KM} km.` };
  }

  const hasExplicit = input.centerLat != null && input.centerLng != null;
  if ((input.centerLat != null) !== (input.centerLng != null)) {
    return { ok: false, error: "center_invalid", hint: "Pass both centerLat and centerLng, or neither." };
  }
  let centerLat: number;
  let centerLng: number;
  if (hasExplicit) {
    centerLat = Number(input.centerLat);
    centerLng = Number(input.centerLng);
    if (!Number.isFinite(centerLat) || Math.abs(centerLat) > 90 || !Number.isFinite(centerLng) || Math.abs(centerLng) > 180) {
      return { ok: false, error: "center_invalid", hint: "centerLat must be in [-90, 90], centerLng in [-180, 180]." };
    }
  } else {
    const profile = await prisma.localProfile.findUnique({ where: { siteId: site.id }, select: { lat: true, lng: true } });
    if (profile?.lat == null || profile?.lng == null) {
      return {
        ok: false,
        error: "profile_no_coords",
        hint: "The business profile has no coordinates. Set lat/lng in Local → Business profile, or pass centerLat/centerLng explicitly.",
      };
    }
    centerLat = profile.lat;
    centerLng = profile.lng;
  }

  // Resolve creds BEFORE the row exists: a scan that can never run must not appear in history.
  // The provider is workspace config — stored on the row for the record, never overridable per scan.
  const creds = await getUserSerpCreds(userId);
  if (!creds) {
    return { ok: false, error: "no_serp_key", hint: "Configure a SERP provider in Settings → SEO Tools first." };
  }
  if (!supportsLocation(creds.provider)) {
    return {
      ok: false,
      error: "location_unsupported",
      hint: `${creds.provider} takes no location parameter, so it cannot answer a grid point. Pick Serper, DataForSEO or A-Parser in Settings → SEO Tools.`,
    };
  }

  const row = await prisma.gridScan.create({
    data: {
      siteId: site.id, keyword, centerLat, centerLng, gridSize, radiusKm,
      provider: creds.provider, depth: GRID_SCAN_DEPTH, status: "queued", error: "", points: "[]",
    },
  });
  // Fire-and-forget, the /api/seo/jobs shape: runGridScan never rejects and writes its own
  // terminal status, so there is nothing left for a .catch to add beyond noise.
  void runGridScan(row.id);
  return { ok: true, scan: toData(row), queryCount: gridSize * gridSize };
}

/** Newest scans of a site the caller owns, points parsed. Free read (local SQLite only). */
export async function listGridScans(userId: string, siteDbId: string, limit = 20): Promise<GridScanData[]> {
  const capped = Math.min(50, Math.max(1, limit));
  const rows = await prisma.gridScan.findMany({
    where: { siteId: siteDbId, site: { userId } },
    orderBy: { createdAt: "desc" },
    take: capped,
  });
  return rows.map(toData);
}
