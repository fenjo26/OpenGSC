// MCP tools for the SERP Monitor contour — whole top-N SERP snapshots per market, host-level
// diffs, volatility and storms (/serp-monitor).
//
// Like toolsDrops, everything here mirrors a UI flow one-to-one: the same store functions,
// the same query shapes, the same clamps. All reads are local SQLite ("local"); the one tool
// that reaches outside the instance is serpmon_run — it talks to the instance owner's own
// self-hosted A-Parser through the user's proxies ("net"). Nothing here spends money: A-Parser
// has no per-request cost, so there is no "paid" tool in this group by design.

import { type Json, type McpTool, lim } from "./shared";
import { listProjects, listRuns, marketRows, keywordHistory } from "@/lib/serpmon/store";
import { domainRows } from "@/lib/serpmon/domains";
import { startRun } from "@/lib/serpmon/collector";
import type { DomainQuery, MarketQuery } from "@/lib/serpmon/types";

const MARKET_SORTS: NonNullable<MarketQuery["sort"]>[] = ["keyword", "volatility", "changes"];
const DOMAIN_PRESETS: NonNullable<DomainQuery["preset"]>[] = ["all", "new", "young", "rising", "falling", "bounced"];
const DOMAIN_SORTS: NonNullable<DomainQuery["sort"]>[] = ["keywords", "top10", "bestPos", "firstSeen", "age", "dr"];

const projectId = (args: Json): string => {
  const id = String(args.project_id ?? "").trim();
  if (!id) throw new Error("project_id is required (see serpmon_projects)");
  return id;
};

export const SERPMON_TOOLS: McpTool[] = [
  {
    name: "serpmon_projects",
    cost: "local",
    description:
      "List SERP Monitor projects (/serp-monitor). A project is one market — engine, country, language, device — plus a keyword set; every run snapshots the whole top-100 per keyword and diffs are computed per host. Each row carries the keyword count, last/next run, the latest run's summary (including its storm verdict) and the volatility series of the last 30 runs, so one call answers 'which markets are quiet and which are shaking'.",
    inputSchema: { type: "object", properties: {} },
    handler: async (userId) => {
      const projects = await listProjects(userId);
      return { count: projects.length, projects };
    },
  },

  {
    name: "serpmon_market",
    cost: "local",
    description:
      "The market table of one SERP Monitor project: per keyword the current leaders, the changes since its last comparable snapshot, RBO volatility and the project's own position. Two facts hold everywhere in this module: changes are HOST-level (a host has one best position and one change — `urls` is a side count, not one entry per URL), and a `failed` snapshot never enters a comparison — a burned proxy cannot fake mass exits. Comparison always runs against the previous snapshot with status ok or partial, within their common depth. Filters: q (keyword substring), host, group, changed_only, sort (keyword | volatility | changes), page, limit ≤ 200.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: {
        project_id: { type: "string", description: "project id from serpmon_projects" },
        q: { type: "string", description: "keyword substring filter" },
        host: { type: "string", description: "only keywords whose latest snapshot contains this host" },
        group: { type: "string", description: "only keywords in this import group" },
        changed_only: { type: "boolean", description: "only keywords whose latest comparison had visible host changes" },
        sort: { type: "string", description: "one of: keyword, volatility, changes (default keyword)" },
        page: { type: "number", description: "1-based page" },
        limit: { type: "number", description: "rows per page, default 50, max 200" },
      },
    },
    handler: async (userId, args) => {
      const sort = MARKET_SORTS.includes(String(args.sort) as NonNullable<MarketQuery["sort"]>)
        ? (String(args.sort) as NonNullable<MarketQuery["sort"]>) : undefined;
      const page = await marketRows(userId, projectId(args), {
        q: typeof args.q === "string" && args.q ? args.q : undefined,
        host: typeof args.host === "string" && args.host ? args.host : undefined,
        group: typeof args.group === "string" && args.group ? args.group : undefined,
        changedOnly: args.changed_only === true,
        sort,
        page: lim(args.page, 1, 1_000_000),
        pageSize: lim(args.limit, 50, 200),
      });
      if (!page) throw new Error("project_not_found");
      return page;
    },
  },

  {
    name: "serpmon_keyword_history",
    cost: "local",
    description:
      "Full SERP history of one keyword inside a SERP Monitor project: every snapshot with its status (ok | partial | failed), problem code, depth, rows fetched, volatility and change count, plus the position series of the ≤ 10 hosts with the most presence aligned to those snapshots. Failed snapshots are kept in the history (with their problem) but sit outside every comparison. Get keyword ids from serpmon_market.",
    inputSchema: {
      type: "object",
      required: ["keyword_id"],
      properties: {
        keyword_id: { type: "string", description: "keywordId from serpmon_market rows" },
        limit: { type: "number", description: "snapshots to return, newest first, default 30, max 200" },
      },
    },
    handler: async (userId, args) => {
      const keywordId = String(args.keyword_id ?? "").trim();
      if (!keywordId) throw new Error("keyword_id is required");
      const history = await keywordHistory(userId, keywordId, lim(args.limit, 30, 200));
      if (!history) throw new Error("keyword_not_found");
      return history;
    },
  },

  {
    name: "serpmon_storms",
    cost: "local",
    description:
      "Recent runs of one SERP Monitor project with their storm verdicts: per run the ok/partial/failed counters, how many keywords were compared, median volatility, share of keywords above their own usual churn, and the storm verdict — a robust z-score of this run's volatility against the project's OWN baseline (a gambling market runs hotter than a boring one; nothing is absolute), storm=true from z ≥ 3 plus ≥ 30% of keywords above their own p90. The first runs (< 7 done runs) are calibration: no verdict is given yet, 'calibrating' — not 'no storms'. Storm detection is a property of a finished run; failed snapshots inside it never produce exits. Also the way to follow a run started with serpmon_run, which is asynchronous.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: {
        project_id: { type: "string", description: "project id from serpmon_projects" },
        limit: { type: "number", description: "runs to return, newest first, default 30, max 200" },
      },
    },
    handler: async (userId, args) => {
      const runs = await listRuns(userId, projectId(args), lim(args.limit, 30, 200));
      const latest = runs[0] ?? null;
      return {
        runs,
        latest,
        ...(latest?.calibrating
          ? { note: "calibrating: fewer than 7 done runs collected — no storm verdicts yet" }
          : {}),
      };
    },
  },

  {
    name: "serpmon_domains",
    cost: "local",
    description:
      "The domain catalogue of one SERP Monitor project: who holds how many keywords and at what best/average position, who is rising or falling run-over-run, who is new (first seen after the project's first run), young (registered < N months ago), bounced (entered and exited within 7 runs), platform or the project's own domain — with registration age and DR where the enrichment has run. Presets like the UI: all, new, young, rising, falling, bounced. Counts are per host, the same host-level convention as every SERP Monitor surface.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: {
        project_id: { type: "string", description: "project id from serpmon_projects" },
        preset: { type: "string", description: `one of: ${DOMAIN_PRESETS.join(", ")} (default all)` },
        q: { type: "string", description: "host substring filter" },
        max_age_months: { type: "number", description: "young cutoff in months (default 6)" },
        include_platforms: { type: "boolean", description: "include social networks / app stores / wikipedia (hidden by default)" },
        sort: { type: "string", description: `one of: ${DOMAIN_SORTS.join(", ")} (default keywords)` },
        page: { type: "number", description: "1-based page" },
        limit: { type: "number", description: "rows per page, default 50, max 200" },
      },
    },
    handler: async (userId, args) => {
      const preset = DOMAIN_PRESETS.includes(String(args.preset) as NonNullable<DomainQuery["preset"]>)
        ? (String(args.preset) as NonNullable<DomainQuery["preset"]>) : undefined;
      const sort = DOMAIN_SORTS.includes(String(args.sort) as NonNullable<DomainQuery["sort"]>)
        ? (String(args.sort) as NonNullable<DomainQuery["sort"]>) : undefined;
      const page = await domainRows(userId, projectId(args), {
        preset,
        q: typeof args.q === "string" && args.q ? args.q : undefined,
        maxAgeMonths: typeof args.max_age_months === "number" && args.max_age_months > 0 ? args.max_age_months : undefined,
        includePlatforms: args.include_platforms === true,
        sort,
        page: lim(args.page, 1, 1_000_000),
        pageSize: lim(args.limit, 50, 200),
      });
      if (!page) throw new Error("project_not_found");
      return page;
    },
  },

  {
    name: "serpmon_run",
    cost: "net",
    idempotent: false,
    description:
      "Start a SERP Monitor check now (manual trigger): every active keyword of the project is re-collected top-N through the instance owner's self-hosted A-Parser (SE::Google) over the user's own proxies. No per-request cost — but the fetch leaves the server, hence cost: net. ASYNCHRONOUS: returns the new runId immediately and snapshots appear per keyword while it runs; check progress and the storm verdict with serpmon_storms. Error codes: cooldown (checked within the last 10 minutes — pass force: true to run anyway), already_running, no_creds (A-Parser not configured), no_keywords, not_found.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: {
        project_id: { type: "string", description: "project id from serpmon_projects" },
        force: { type: "boolean", description: "true = ignore the 10-minute manual-run cooldown" },
      },
    },
    handler: async (userId, args) => {
      const res = await startRun(userId, projectId(args), "manual", { force: args.force === true });
      if ("error" in res) return { started: false, error: res.error };
      return {
        started: true,
        runId: res.runId,
        note: "the run is asynchronous — follow it with serpmon_storms (per-keyword snapshots land as they finish)",
      };
    },
  },
];
