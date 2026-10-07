// MCP tools for Local SEO (N4, brief §8): the stored business profile, and the NAP check that
// walks the site's own pages. Everything else on /local (schema generator, citations, GBP) is
// either a pure UI operation or needs the operator's eyes — the tools here are the ones an
// agent can act on: read the card, re-run the consistency check whose result feeds nothing
// else (the report is live, never stored), and the geo-grid (wave G) — read its history, or
// start a scan through the exact path the /local card uses.

import { type McpTool, resolveSite } from "./shared";
import { getProfile, localSchemaMissing } from "@/lib/local/store";
import { runNapCheck } from "@/lib/local/runner";
import { buildLocalBusinessSchema, validateLocalBusinessSchema } from "@/lib/local/schema";
import { createAndRunGridScan, listGridScans, summarizePoints } from "@/lib/localGrid/run";

export const LOCAL_TOOLS: McpTool[] = [
  {
    name: "get_local_profile",
    cost: "local",
    readOnly: true,
    description:
      "Local SEO business card of one site: name, schema.org business type, NAP (address, phone in E.164, e-mail), coordinates, opening hours, price range, sameAs profiles, service areas, and the selected Google Business Profile account/location. Includes the generated LocalBusiness JSON-LD and Google-requirements validation (required fields, recommended-field warnings). Returns { profile: null } when the site has no card yet — nothing is guessed from the domain.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property (sc-domain:example.com or URL), or bare domain" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const profile = await getProfile(userId, site.id);
        if (!profile) return { profile: null };
        const schema = buildLocalBusinessSchema(profile, { url: site.url });
        return {
          profile,
          schema,
          validation: validateLocalBusinessSchema(schema, profile.businessType),
        };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
  {
    name: "check_nap",
    cost: "net",
    description:
      "NAP consistency check of one site against its business card: fetches the homepage and up to 10 contact-ish pages (free, one request each), extracts name/phones/address (JSON-LD first, then microdata, then text) and reports every field as match | differs | missing with the expected and found values. Requires a profile (create it in Local → Business profile first). The report is returned live and never stored.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property, or bare domain" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const profile = await getProfile(userId, site.id);
        if (!profile) {
          return { error: "profile_required", hint: "Create the business card in Local → Business profile, then re-run check_nap." };
        }
        const report = await runNapCheck(profile, site.url);
        return { report };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
  {
    name: "local_grid_scans",
    cost: "local",
    readOnly: true,
    description:
      "Geo-grid scan history of one site (Local Falcon-style): every stored scan with status (queued/running/done/error), keyword, grid size, radius, provider, and a per-scan point summary — average rank, in-map-pack share, errored/not-found counts. Running scans show partial results (points persist as they are answered); re-call to follow progress. Free read of this instance's database.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property, or bare domain" },
        limit: { type: "number", description: "Max scans to return (default 20, max 50)" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const scans = await listGridScans(userId, site.id, typeof args.limit === "number" ? args.limit : 20);
        return {
          scans: scans.map(s => ({
            id: s.id, keyword: s.keyword, status: s.status, error: s.error || undefined,
            gridSize: s.gridSize, radiusKm: s.radiusKm, provider: s.provider,
            center: { lat: s.centerLat, lng: s.centerLng },
            createdAt: s.createdAt,
            summary: summarizePoints(s.points),
            points: s.points,
          })),
        };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
  {
    name: "local_grid_scan_run",
    cost: "paid",
    description:
      "Start a geo-grid rank scan (Local Falcon-style) for one keyword: the keyword is checked at gridSize² coordinate points spread over a square around the business, each point geolocated to its own lat,lng, so the result shows where the map pack actually reaches. COST: gridSize² SERP queries on the workspace's configured Rank Tracker provider (9 for 3×3, 25 for 5×5, 49 for 7×7) — free on a personal A-Parser instance, metered on Serper/DataForSEO. The scan runs in the background; poll local_grid_scans for its points. Defaults: centre = the business profile's coordinates (profile_no_coords when neither the profile nor explicit centerLat/centerLng state any — never a guessed city), gridSize 5, radiusKm 2 (0.1–100).",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property, or bare domain" },
        keyword: { type: "string", description: "The keyword to check at every grid point" },
        gridSize: { type: "number", description: "Grid edge: 3, 5 or 7 (default 5). The scan costs gridSize² queries." },
        radiusKm: { type: "number", description: "Centre → outer edge in km, 0.1–100 (default 2)" },
        centerLat: { type: "number", description: "Scan centre override; pass with centerLng to skip the business profile location" },
        centerLng: { type: "number", description: "Scan centre override; pass with centerLat" },
      },
      required: ["site", "keyword"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const result = await createAndRunGridScan(userId, site.id, {
          keyword: String(args.keyword ?? ""),
          gridSize: typeof args.gridSize === "number" ? args.gridSize : 5,
          radiusKm: typeof args.radiusKm === "number" ? args.radiusKm : 2,
          centerLat: num(args.centerLat),
          centerLng: num(args.centerLng),
        });
        if (!result.ok) {
          return { error: result.error, ...(result.hint ? { hint: result.hint } : {}) };
        }
        // The row is the answer: what it will cost, and where to watch it fill in.
        return {
          scan: result.scan,
          queryCount: result.queryCount,
          note: "Running in the background — poll local_grid_scans for points as they are answered.",
        };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
];
