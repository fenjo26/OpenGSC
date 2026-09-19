// MCP tools for the drops contour — the expired-domain catalogue (/drops) as an agent surface.
//
// Everything here mirrors a UI flow one-to-one: the same store functions, the same batch sizes,
// the same budgets. The long stages stay bounded slices on purpose, and the two tools that
// reach outside the instance say so in their cost: the registry check resolves DNS and asks
// public RDAP/WHOIS ("net"), the AI history pass spends the owner's LLM credits ("paid",
// confirm: true). The free enrichment sources (DR via the free Ahrefs endpoint, Wayback CDX)
// leave the server too, so they are "net" as well; only refdomains are "paid" — they bill
// Ahrefs units, and the tool refuses without confirm like every other spending tool.

import {
  type Json, type McpTool, lim,
} from "./shared";
import { resolveAiCreds, assertConfirmed } from "./shared";
import { createRun, listCandidates, stageCounts, pendingDnsCandidates, countPendingDns, recordDnsResults, pendingAvailabilityCandidates, countPendingAvailability, markUncheckableZones, recordAvailabilityResults, writeWaybackResults, writeMetricsUpdates, setHistoryVerdict, setWatchedByDomains, countWatched, storedWaybackTimestamps, parseCandidateFilter, listDropGroups, createDropGroup, renameDropGroup, deleteDropGroup, dropGroupExists, setCandidateGroup, type CandidateSortField } from "@/lib/drops/store";
import { checkDnsBatch } from "@/lib/drops/dns";
import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { profileForDomain, registryAnswerable } from "@/lib/drops/registries";
import { easyGrCreds } from "@/lib/drops/easyGr";
import { fetchSnapshotTimestamps, fetchWaybackProfile } from "@/lib/drops/wayback";
import { drForDomains } from "@/lib/drops/drFree";
import { flagDrSeries, readDrHistory, recordDrSnapshots } from "@/lib/seo/drHistory";
import { getOwnerSettings } from "@/lib/engineKeysServer";
import { analyseDomainHistory } from "@/lib/drops/history";
import { fetchLLM } from "@/lib/llm";
import { goanyDrHistory } from "@/lib/seo/goanyapi";
import { fetchDomainMetrics, fetchMajesticItemStats, domainUnits, parseMetricsProvider } from "@/lib/seo/metrics";
import { MAJESTIC_STATS_UNITS } from "@/lib/seo/metricsPricing";
import type { DropSource, DropStage } from "@/lib/drops/types";
import { runToxSlice } from "@/lib/drops/toxicity/stage";
import { prisma } from "@/lib/prisma";
import { buildGluePlan } from "@/lib/drops/glue/generate";
import { parsePage } from "@/lib/drops/glue/parse";
import { validateCluster } from "@/lib/drops/glue/validate";
import { detectCloaking, fetchClusterPages, withFindings } from "@/lib/drops/glue/fetchPages";
import type { GlueMode, GluePlan, GlueSpec } from "@/lib/drops/glue/types";

const STAGES: DropStage[] = [
  "ingested", "dns_checked", "no_registry", "resolved_taken", "checking",
  "available", "taken", "confirmed", "rejected", "acquired",
];
const SOURCES: DropSource[] = ["csv", "ahrefs_refdomains", "ahrefs_broken", "crawler", "zone_diff"];
const SORT_FIELDS: CandidateSortField[] = ["score", "createdAt", "domain", "dr", "refdomains", "snapshots", "checkedAt", "tf", "history"];

const CHECK_DEADLINE_MS = 35_000;

/** The domains a list command names, cleaned the way the routes clean them. */
function domainsArg(args: Json): string[] {
  return (Array.isArray(args.domains) ? args.domains : [])
    .filter((d): d is string => typeof d === "string")
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

/** The scope a bulk group action acts over: explicit row ids or a drops_list-shaped filter. */
function bulkScope(args: Json): { ids?: string[]; filter?: ReturnType<typeof parseCandidateFilter> } {
  const ids = (Array.isArray(args.ids) ? args.ids : [])
    .filter((v): v is string => typeof v === "string")
    .slice(0, 500);
  if (ids.length) return { ids };
  if (args.filter && typeof args.filter === "object") {
    return { filter: parseCandidateFilter(args.filter as Record<string, unknown>) };
  }
  throw new Error("ids or filter required");
}

/** Trust/Citation Flow read back out of a Majestic GetIndexItemInfo raw row. */
function mjFlow(payload: unknown): { tf?: number; cf?: number } {
  let row: Record<string, unknown> | undefined;
  try { row = typeof payload === "string" ? JSON.parse(payload) : (payload as Record<string, unknown>); } catch { return {}; }
  if (!row || typeof row !== "object") return {};
  const lower = new Map(Object.keys(row).map(k => [k.toLowerCase(), k]));
  const n = (name: string) => {
    const v = lower.has(name) ? row![lower.get(name)!] : null;
    const num = Number(v);
    return v != null && v !== "" && Number.isFinite(num) ? num : undefined;
  };
  return { tf: n("trustflow"), cf: n("citationflow") };
}

function stageCountsSummary(userId: string, runId?: string) {
  return stageCounts(userId, runId);
}

const row = (r: Record<string, unknown>) => ({
  domain: r.domain, tld: r.tld, stage: r.stage,
  dr: r.dr ?? null, refdomains: r.refdomainsDofollow ?? r.refdomains ?? null,
  tf: r.majesticTf ?? null, cf: r.majesticCf ?? null,
  groupId: r.groupId ?? null, group: (r.group as { name?: string } | null)?.name ?? null,
  waybackSnapshots: r.waybackSnapshots ?? null, waybackGapDays: r.waybackGapDays ?? null,
  score: r.score ?? null, historyVerdict: r.historyVerdict ?? null, historyNote: r.historyNote ?? null,
  /** Parsed back out of the free classifier's note — no dedicated column until one is earned. */
  historyScore: Number(/^score (\d+)/.exec(String(r.historyNote ?? ""))?.[1] ?? "") || null,
  corroborated: r.corroborated === true, watched: r.watched === true, lastError: r.lastError ?? null,
  lastCheckedAt: r.lastCheckedAt ?? null,
});

export const DROPS_TOOLS: McpTool[] = [
  {
    name: "drops_list",
    cost: "local",
    description:
      "List the expired-domain catalogue (/drops): candidates with stage, DR, refdomains, Majestic TF/CF, group, Wayback snapshots, score, hard veto (spam_history | idle_over_2y | dr_drop | pbn_profile — a veto caps the score at 0 and means 'do not buy') and AI history verdict. Filters: runId, stage, tld, q (domain substring), starred, watched, groupId / ungrouped, minScore, noVeto (the buyable cut — only rows where nothing fired), and inclusive numeric ranges — drMin/drMax (drNull=true for rows never rated — a different thing from DR 0), refMin/refMax on the displayed refdomain count, tfMin/tfMax on Majestic Trust Flow; sorted page. Returns the funnel stage counts alongside, so one call answers 'what does the catalogue look like'.",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", description: `funnel stage, one of: ${STAGES.join(", ")}` },
        runId: { type: "string", description: "restrict to one import run" },
        tld: { type: "string", description: "zone without the dot, e.g. gr" },
        q: { type: "string", description: "domain substring" },
        starred: { type: "boolean" },
        watched: { type: "boolean", description: "only rows the watch loop is polling" },
        minScore: { type: "number" },
        drMin: { type: "number", description: "minimum DR, inclusive — e.g. 10 for 'DR ≥ 10'" },
        drMax: { type: "number", description: "maximum DR, inclusive — e.g. 5 for the garbage band 0–5" },
        drNull: { type: "boolean", description: "true = only rows with no DR yet (never enriched, or Ahrefs has no rating); independent of drMin/drMax" },
        refMin: { type: "number", description: "minimum referring domains, inclusive (dofollow when known, total otherwise)" },
        refMax: { type: "number", description: "maximum referring domains, inclusive" },
        tfMin: { type: "number", description: "minimum Majestic Trust Flow, inclusive" },
        tfMax: { type: "number", description: "maximum Majestic Trust Flow, inclusive" },
        noVeto: { type: "boolean", description: "true = only rows with no hard veto (the buyable cut); veto values: spam_history, idle_over_2y, dr_drop (DR fell ≥5 in the monthly series), pbn_profile (TF far below DR)" },
        history: { type: "string", description: "history verdict filter: clean | empty | suspicious | toxic (the free classifier) or none (never classified). historyScore in the row is parsed from the note" },
        groupId: { type: "string", description: "only rows in this curated group (see drops_groups)" },
        ungrouped: { type: "boolean", description: "true = only rows in no group" },
        limit: { type: "number", description: "rows per page, default 50, max 200" },
        offset: { type: "number" },
        orderBy: { type: "string", description: `one of: ${SORT_FIELDS.join(", ")} (default score)` },
        order: { type: "string", description: "asc | desc (default desc)" },
      },
    },
    handler: async (userId, args) => {
      const sortField = SORT_FIELDS.includes(String(args.orderBy) as CandidateSortField)
        ? (String(args.orderBy) as CandidateSortField) : "score";
      const stage = STAGES.includes(String(args.stage) as DropStage) ? (String(args.stage) as DropStage) : undefined;
      const source = SOURCES.includes(String(args.source) as DropSource) ? (String(args.source) as DropSource) : undefined;
      const page = await listCandidates(userId, {
        stage,
        source,
        runId: typeof args.runId === "string" && args.runId ? args.runId : undefined,
        tld: typeof args.tld === "string" && args.tld ? args.tld.toLowerCase().replace(/^\./, "") : undefined,
        q: typeof args.q === "string" ? args.q : undefined,
        starred: args.starred === true ? true : undefined,
        watched: args.watched === true ? true : undefined,
        minScore: typeof args.minScore === "number" ? args.minScore : undefined,
        drMin: typeof args.drMin === "number" ? args.drMin : undefined,
        drMax: typeof args.drMax === "number" ? args.drMax : undefined,
        drNull: args.drNull === true ? true : undefined,
        refMin: typeof args.refMin === "number" ? args.refMin : undefined,
        refMax: typeof args.refMax === "number" ? args.refMax : undefined,
        tfMin: typeof args.tfMin === "number" ? args.tfMin : undefined,
        tfMax: typeof args.tfMax === "number" ? args.tfMax : undefined,
        noVeto: args.noVeto === true ? true : undefined,
        history: ["clean", "empty", "suspicious", "toxic", "none"].includes(String(args.history))
          ? (String(args.history) as "clean" | "empty" | "suspicious" | "toxic" | "none")
          : undefined,
        groupId: typeof args.groupId === "string" && args.groupId ? args.groupId : undefined,
        ungrouped: args.ungrouped === true ? true : undefined,
        limit: lim(args.limit, 50, 200),
        offset: lim(args.offset, 0, 1_000_000) - 1,
        orderBy: sortField,
        orderDir: args.order === "asc" ? "asc" : "desc",
      });
      const counts = await stageCountsSummary(userId, typeof args.runId === "string" && args.runId ? args.runId : undefined);
      return {
        total: page.total, limit: page.limit, offset: page.offset, counts,
        rows: (page.rows as Record<string, unknown>[]).map(row),
      };
    },
  },

  {
    name: "drops_ingest",
    cost: "local",
    idempotent: false,
    description:
      "Import a list of domains into the drops catalogue as a new run. `raw` is pasted text or CSV — URLs, www.-prefixed hosts, IPs and junk rows are normalised or rejected with a per-reason report (rows reduce to their registrable apex). Returns accepted/inserted/duplicated counts.",
    inputSchema: {
      type: "object",
      required: ["raw"],
      properties: {
        raw: { type: "string", description: "the list itself: one domain per line or a CSV (the first domain-like column wins)" },
        label: { type: "string", description: "human label for the run" },
        source: { type: "string", description: `one of: ${SOURCES.join(", ")} (default csv)` },
      },
    },
    handler: async (userId, args) => {
      const raw = typeof args.raw === "string" ? args.raw : "";
      if (!raw.trim()) throw new Error("raw is required");
      const source = SOURCES.includes(String(args.source) as DropSource) ? (String(args.source) as DropSource) : "csv";
      return createRun(userId, {
        raw,
        label: typeof args.label === "string" ? args.label : null,
        source,
      });
    },
  },

  {
    name: "drops_prefilter",
    cost: "net",
    idempotent: false,
    description:
      "Run one bounded slice of the DNS pre-filter on ingested rows: resolves NS records and retires every delegated (alive) domain for free, advancing the rest to the registry stage. Returns { checked, retired, advanced, remaining, done } — call repeatedly while remaining > 0 and done is false. The free stage that should always run first.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        batch: { type: "number", description: "rows this slice, default 200, max 1000" },
      },
    },
    handler: async (userId, args) => {
      const runId = typeof args.runId === "string" && args.runId ? args.runId : undefined;
      const batch = lim(args.batch, 200, 1000);
      const domains = await pendingDnsCandidates(userId, { runId, limit: batch });
      if (!domains.length) return { checked: 0, retired: 0, advanced: 0, remaining: await countPendingDns(userId, runId), done: true };
      const results = await checkDnsBatch(domains, { concurrency: 40 });
      const written = await recordDnsResults(
        userId,
        domains.map(domain => {
          const r = results.get(domain);
          return { domain, hasRecords: !!r?.hasRecords, nameServers: r?.nameServers ?? [] };
        }),
      );
      const remaining = await countPendingDns(userId, runId);
      return { checked: domains.length, retired: written.retired, advanced: written.advanced, remaining, done: remaining === 0 };
    },
  },

  {
    name: "drops_check",
    cost: "net",
    idempotent: false,
    description:
      "Run one bounded slice of the registry availability check (RDAP then WHOIS, throttled per zone, ~35s wall-clock budget). Returns { checked, available, taken, deferred, uncheckable, remaining, done }: call repeatedly while remaining > 0 and done is false. `uncheckable` counts rows whose zone has no public registry (e.g. .gr) — those need a registrar API and are parked for a week. An `available` verdict must be corroborated=true before it is treated as free.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        batch: { type: "number", description: "rows per slice, default 40, max 200" },
      },
    },
    handler: async (userId, args) => {
      const runId = typeof args.runId === "string" && args.runId ? args.runId : undefined;
      const batch = lim(args.batch, 40, 200);
      const pending = await pendingAvailabilityCandidates(userId, { runId, limit: batch });
      if (!pending.length) {
        const remaining = await countPendingAvailability(userId, runId);
        return { checked: 0, available: 0, taken: 0, deferred: 0, uncheckable: 0, remaining, done: remaining === 0 };
      }
      const answerable: string[] = [];
      const uncheckable: string[] = [];
      for (const domain of pending) {
        const profile = profileForDomain(domain);
        (profile && registryAnswerable(profile, Boolean(easyGrCreds())) ? answerable : uncheckable).push(domain);
      }
      const [results, skipped] = await Promise.all([
        checkAvailabilityBatch(answerable, { deadlineMs: CHECK_DEADLINE_MS }),
        markUncheckableZones(userId, uncheckable),
      ]);
      const written = await recordAvailabilityResults(userId, results);
      const remaining = await countPendingAvailability(userId, runId);
      return {
        checked: results.size,
        ...written,
        uncheckable: skipped,
        remaining,
        done: remaining === 0 || (written.decided === 0 && skipped === 0),
      };
    },
  },

  {
    name: "drops_enrich_wayback",
    cost: "net",
    idempotent: false,
    description:
      "Fetch Wayback Machine snapshots for up to 12 domains: months archived, first/last seen, days since death. Free and keyless. Writes into the catalogue and updates the score (stale domains get vetoed down).",
    inputSchema: {
      type: "object",
      required: ["domains"],
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 12 domains" },
      },
    },
    handler: async (userId, args) => {
      const domains = domainsArg(args).slice(0, 12);
      if (!domains.length) throw new Error("domains required");
      const results: { domain: string; snapshots: number; firstAt: Date | null; lastAt: Date | null; gapDays: number | null }[] = [];
      const skipped: { domain: string; reason: string }[] = [];
      for (const domain of domains) {
        const out = await fetchWaybackProfile(domain);
        // A refused domain is reported with its reason — a silent skip read as "the tool lost it".
        if (!out.ok) { skipped.push({ domain, reason: out.reason }); continue; }
        results.push({
          domain,
          snapshots: out.profile!.snapshots,
          firstAt: out.profile!.firstAt,
          lastAt: out.profile!.lastAt,
          gapDays: out.profile!.gapDays,
        });
      }
      const updated = await writeWaybackResults(userId, results);
      return { updated, results, ...(skipped.length ? { skipped } : {}) };
    },
  },

  {
    name: "drops_enrich_dr",
    cost: "net",
    idempotent: false,
    description:
      "Fetch Ahrefs Domain Rating for up to 60 domains through the free public endpoint (needs the free Ahrefs DR key in Settings → SEO Metrics, or falls back to the paid Ahrefs key; 7-day server cache). " +
      "Every fresh rating also lands in the panel's own monthly DR history (DrSnapshot), and the response carries each domain's accumulated series with a penalty flag (a fall of ≥5 points across the window reads as a Google filter, not lost links). " +
      "Attribution required when displayed: 'Domain Rating by Ahrefs'.",
    inputSchema: {
      type: "object",
      required: ["domains"],
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 60 domains" },
      },
    },
    handler: async (userId, args) => {
      const domains = domainsArg(args).slice(0, 60);
      if (!domains.length) throw new Error("domains required");
      // One resolver for both surfaces (this tool and the page's button): free DR key first,
      // paid Ahrefs key as fallback — an APIv3 key is an APIv3 key, and DrCache is shared.
      const { ratings, keyFound } = await drForDomains(userId, domains);
      if (!keyFound) throw new Error("no_ahrefs_key: set the free DR key in Settings → SEO Metrics (or any paid Ahrefs key)");
      const updated = await writeMetricsUpdates(userId, Object.entries(ratings).map(([domain, dr]) => ({ domain, dr })));
      // The accumulated series rides along: one call answers "what is the DR" and "what has it
      // been doing" — the second half is the buy/no-buy signal.
      const history = await readDrHistory(domains);
      const flags: Record<string, ReturnType<typeof flagDrSeries>> = {};
      for (const d of Object.keys(history)) flags[d] = flagDrSeries(history[d]);
      return { updated, ratings, history, flags, attribution: "Domain Rating by Ahrefs — https://ahrefs.com/" };
    },
  },

  {
    name: "drops_enrich_refdomains",
    cost: "paid",
    idempotent: false,
    description:
      "PAID: fetch Ahrefs refdomains/backlink counts for up to 25 domains through the configured metrics provider — spends the owner's Ahrefs units (~100 units per domain, the 50-unit floor doubled). Do not run for the whole catalogue; run for shortlisted rows. Needs confirm: true.",
    inputSchema: {
      type: "object",
      required: ["domains", "confirm"],
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 25 shortlisted domains" },
        confirm: { type: "boolean", description: "must be true — this spends Ahrefs units" },
      },
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "drops_enrich_refdomains bills metrics units (Ahrefs or Majestic)");
      const domains = domainsArg(args).slice(0, 25);
      if (!domains.length) throw new Error("domains required");
      // Same key chain the warmup cron uses — the one server-side authority on where this
      // instance's metrics credentials live (mode slots, reseller/custom overrides, fallbacks).
      const settings = await getOwnerSettings(userId);
      const provider = parseMetricsProvider(settings.seoMetricsProvider);
      const mode = String(settings[`seoMetricsMode_${provider}`] ?? "");
      const slot = mode === "reseller" || mode === "custom" ? `seoKey_${provider}__${mode}` : `seoKey_${provider}`;
      const apiKey = String(settings[slot] ?? settings[`seoKey_${provider}`] ?? "").trim();
      if (!apiKey) throw new Error("no_metrics_key: configure SEO Metrics in settings");
      const baseUrl = String(settings[`seoMetricsBaseUrl_${provider}`] ?? "").trim();

      // The reservation ladder from /api/metrics/domain: reserve the floor up front, hand back
      // whatever the failed share did not bill. Without it a 404 mid-batch would be a silent
      // donation to the provider.
      const { recordUsage, withinCap, releaseUnusedUnits } = await import("@/lib/seo/metricsStore");
      const perDomain = domainUnits(provider);
      const units = perDomain * domains.length;
      // cap 0 means "no cap configured" — withinCap passes it through as unlimited.
      const cap = Math.max(0, Number(settings.seoMetricsCap ?? 0));
      if (!(await withinCap(userId, provider, units, cap))) throw new Error("cap_exceeded: monthly metrics cap would be exceeded — raise the cap or shrink the batch");
      await recordUsage(userId, provider, units);

      const results: { domain: string; refdomains?: number; backlinks?: number; tf?: number; cf?: number }[] = [];
      for (const domain of domains) {
        const res = await fetchDomainMetrics({ provider, apiKey, baseUrl }, domain);
        if (res.error || !res.items.length) continue;
        const m = res.items[0];
        // Majestic's raw row carries Trust/Citation Flow the metrics shape drops — rescue them
        // so a TF-filtered workflow does not need a second tool call.
        results.push({ domain, refdomains: m.refDomains ?? undefined, backlinks: m.backlinks ?? undefined, ...(provider === "majestic" ? mjFlow(m.payload) : {}) });
      }
      await releaseUnusedUnits(userId, provider, units, perDomain * results.length);
      const updated = await writeMetricsUpdates(userId, results);
      return { updated, results, unitsSpent: perDomain * results.length };
    },
  },

  {
    name: "drops_enrich_tf",
    cost: "paid",
    idempotent: false,
    description:
      "PAID: fetch Majestic Trust Flow / Citation Flow for up to 100 domains in one batched GetIndexItemInfo call — the cheapest meaningful enrichment (1 Majestic unit per domain, i.e. well under a cent each) and the read a DR number cannot replace: TF catches a PBN-heavy profile DR is happy with. Writes majesticTf/majesticCf onto the rows; drops_list can then filter and sort by TF. Needs confirm: true.",
    inputSchema: {
      type: "object",
      required: ["domains", "confirm"],
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 100 domains — the call is batched, so this is cheap even at the ceiling" },
        confirm: { type: "boolean", description: "must be true — this spends Majestic units" },
      },
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "drops_enrich_tf bills Majestic units");
      const domains = domainsArg(args).slice(0, 100);
      if (!domains.length) throw new Error("domains required");
      // Majestic-specific slot resolution — the active provider may be Ahrefs, but TF lives
      // in Majestic. Same mode/key convention the settings screen and SeoKeysSync use.
      const settings = await getOwnerSettings(userId);
      const mode = String(settings.seoMetricsMode_majestic ?? "");
      const slot = mode === "reseller" || mode === "custom" ? `seoKey_majestic__${mode}` : "seoKey_majestic";
      const apiKey = String(settings[slot] ?? settings.seoKey_majestic ?? "").trim();
      if (!apiKey) throw new Error("no_majestic_key: add a Majestic key in Settings → SEO Metrics");
      const baseUrl = String(settings.seoMetricsBaseUrl_majestic ?? "").trim();

      const { recordUsage, withinCap, releaseUnusedUnits } = await import("@/lib/seo/metricsStore");
      const units = MAJESTIC_STATS_UNITS * domains.length;
      const cap = Math.max(0, Number(settings.seoMetricsCap_majestic ?? 0));
      if (!(await withinCap(userId, "majestic", units, cap))) throw new Error("cap_exceeded: monthly Majestic cap would be exceeded — raise the cap or shrink the batch");
      await recordUsage(userId, "majestic", units);

      const res = await fetchMajesticItemStats({ provider: "majestic", apiKey, baseUrl }, domains);
      const spent = res.items.length ? res.units : 0;
      await releaseUnusedUnits(userId, "majestic", units, spent);
      if (res.error && !res.items.length) throw new Error(res.error);
      // An item the index has never seen simply has no row — billed for what came back.
      const updated = await writeMetricsUpdates(userId, res.items.map(r => ({
        domain: r.item, tf: r.trustFlow ?? undefined, cf: r.citationFlow ?? undefined,
      })));
      return {
        updated,
        results: res.items.map(r => ({ domain: r.item, tf: r.trustFlow, cf: r.citationFlow, refdomains: r.refDomains, backlinks: r.backlinks })),
        unitsSpent: spent,
        missing: domains.filter(d => !res.items.some(r => r.item === d)),
      };
    },
  },

  {
    name: "drops_groups",
    cost: "local",
    idempotent: false,
    description:
      "Curated groups over the drops catalogue — name a batch of domains once ('buy in October', 'defer'), then work with it as a unit; the /drops table renders them as collapsible sections. Actions: list (default — groups with row counts), create {name}, rename {groupId, name}, delete {groupId} (rows stay in the catalogue, ungrouped), assign {groupId, ids | filter}, unassign {ids | filter}. ids are row ids from drops_list; filter is the same filter dict drops_list takes (stage, runId, tld, q, drMin/drMax/drNull, refMin/refMax, tfMin/tfMax, groupId, ungrouped, watched, starred) — so 'put everything with DR < 10 into a group' is one call.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "list (default) | create | rename | delete | assign | unassign" },
        name: { type: "string", description: "group name (create/rename)" },
        groupId: { type: "string", description: "target group (rename/delete/assign)" },
        ids: { type: "array", items: { type: "string" }, description: "row ids (assign/unassign), max 500" },
        filter: { type: "object", description: "drops_list-shaped filter (assign/unassign) — bulk over the whole filtered set" },
      },
    },
    handler: async (userId, args) => {
      const action = String(args.action ?? "list");
      if (action === "list" || action === "") {
        const groups = await listDropGroups(userId);
        return { groups, total: groups.reduce((a, g) => a + g.count, 0) };
      }
      if (action === "create") {
        const name = String(args.name ?? "");
        if (!name.trim()) throw new Error("name required");
        return createDropGroup(userId, name);
      }
      if (action === "rename") {
        const groupId = String(args.groupId ?? "");
        const name = String(args.name ?? "");
        if (!groupId || !name.trim()) throw new Error("groupId and name required");
        if (!(await renameDropGroup(userId, groupId, name))) throw new Error("group_not_found");
        const groups = await listDropGroups(userId);
        return { ok: true, groups };
      }
      if (action === "delete") {
        const groupId = String(args.groupId ?? "");
        if (!groupId) throw new Error("groupId required");
        if (!(await deleteDropGroup(userId, groupId))) throw new Error("group_not_found");
        return { ok: true, groups: await listDropGroups(userId) };
      }
      if (action === "assign" || action === "unassign") {
        const groupId = action === "assign" ? String(args.groupId ?? "") : null;
        if (action === "assign") {
          if (!groupId || !(await dropGroupExists(userId, groupId))) throw new Error("group_not_found");
        }
        const updated = await setCandidateGroup(userId, bulkScope(args), groupId);
        return { updated, groups: await listDropGroups(userId) };
      }
      throw new Error(`unknown action: ${action}`);
    },
  },

  {
    name: "drops_dr_history",
    cost: "paid",
    idempotent: false,
    description:
      "Domain Rating history for one domain — the DR series by month, not the snapshot. Free first: " +
      "when the panel has accumulated a local series (DrSnapshot, 2+ months — filled automatically by every fresh DR check and by the watch loop once a month), it is returned at no cost with source:'local', no key and no confirm needed. " +
      "Otherwise it fetches via GoAnyAPI at 2 credits per returned month (includeDr=false = free preview of which months exist) and stores the fetched months locally, so the series never costs twice. " +
      "A DR series is a veto signal a single number cannot be: 22→24→12→11→8 is not lost links, it is a hit — " +
      "read a drop of ≥5 points as a spam/penalty flag before acquiring. Pass vendor:true to force the GoAnyAPI window even when a local series exists. Needs confirm: true for the paid variant.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "One domain to inspect" },
        vendor: { type: "boolean", description: "Skip the free local series and fetch the full GoAnyAPI window (2 credits/month)" },
        confirm: { type: "boolean", description: "must be true for the paid GoAnyAPI fetch; the local series needs neither key nor confirm" },
        includeDr: { type: "boolean", description: "Fetch DR values (default: follows confirm)" },
      },
    },
    handler: async (userId, args) => {
      const domain = String(args.domain ?? "").trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      if (!domain.includes(".")) throw new Error("domain required");

      // Local first. The panel's own series costs nothing, needs no key, and answers the same
      // question the vendor does — the vendor is now the fallback for domains the panel has
      // never seen twice, plus a one-time backfill that becomes local history after the call.
      if (args.vendor !== true) {
        const local = await readDrHistory([domain]);
        const points = local[domain];
        if (points && points.length >= 2) {
          const flag = flagDrSeries(points)!;
          return {
            domain,
            source: "local",
            history: points,
            drFirst: flag.first, drLast: flag.last, change: flag.drop,
            note: flag.flagged
              ? "DR fell materially across the stored window — treat as a spam/penalty flag, not lost links."
              : undefined,
          };
        }
      }

      const includeDr = args.includeDr === true || (args.includeDr !== false && args.confirm === true);
      if (includeDr) assertConfirmed(args, "drops_dr_history bills 2 GoAnyAPI credits per returned month (use includeDr=false for the free preview)");
      const settings = await getOwnerSettings(userId);
      const apiKey = String(settings.seoKey_goanyapi ?? "").trim();
      if (!apiKey) throw new Error("no_goanyapi_key: no local series accumulated yet and no GoAnyAPI key configured (Settings → SEO Tools)");

      const r = await goanyDrHistory(apiKey, domain, includeDr);
      if (!r.data) throw new Error(r.error ?? "no_data");
      // The paid months become permanent local history (source: goanyapi) — this call is the
      // last time they cost anything. Backfilled months are in the past, so they never block
      // the panel's own current-month measurement.
      await recordDrSnapshots(r.data.history
        .filter(m => m.dr != null)
        .map(m => ({ domain, dr: m.dr as number, source: "goanyapi", month: m.month })));
      const drs = r.data.history.map(m => m.dr).filter((v): v is number => v != null);
      const first = r.data.history[0], last = r.data.history[r.data.history.length - 1];
      return {
        domain: r.data.domain,
        source: "goanyapi",
        includeDr,
        history: r.data.history,
        credits: r.credits,
        remainingCredits: r.remaining,
        ...(includeDr && drs.length >= 2 && first && last ? {
          drFirst: first.dr, drLast: last.dr,
          change: (last.dr ?? 0) - (first.dr ?? 0),
          note: first.dr != null && last.dr != null && last.dr - first.dr <= -5
            ? "DR fell materially across the window — treat as a spam/penalty flag, not lost links."
            : undefined,
        } : {}),
      };
    },
  },

  {
    name: "drops_history_ai",
    cost: "paid",
    idempotent: false,
    description:
      "PAID: run the AI history pass over up to 5 hand-picked domains — fetches three Wayback snapshots across the domain's life and asks the configured LLM what the site was about, whether the topic shifted and whether a spam period shows. Writes historyVerdict (clean | topic_shift | spam_period | unknown) + a factual note, and re-scores the row (spam_period vetoes). Uses the dedicated drops-history AI slot (Settings → per-task AI) and falls back to the main AI provider; an explicit aiProvider/aiApiKey argument wins over both. Needs confirm: true — it spends LLM credits. Never run this for whole lists.",
    inputSchema: {
      type: "object",
      required: ["domains", "confirm"],
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 5 hand-picked domains" },
        confirm: { type: "boolean", description: "must be true — this spends LLM credits" },
        aiProvider: { type: "string", description: "override the AI provider for this call" },
        aiApiKey: { type: "string", description: "override the AI key for this call" },
        model: { type: "string", description: "override the model for this call" },
      },
    },
    handler: async (userId, args) => {
      assertConfirmed(args, "drops_history_ai spends LLM credits");
      const domains = domainsArg(args).slice(0, 5);
      if (!domains.length) throw new Error("domains required");
      // The free classifier first: most verdicts are decided deterministically by
      // drops_toxicity at zero cost, and burning LLM credits on an obvious Chinese casino
      // the dictionary already catches is the exact waste this gate exists to prevent.
      const rowsFor = (await prisma.dropCandidate.findMany({
        where: { userId, domain: { in: domains } },
        select: { domain: true, historyNote: true },
      })) as { domain: string; historyNote: string | null }[];
      const freeChecked = new Set(
        rowsFor.filter(r => /^score \d+/.test(r.historyNote ?? "")).map(r => r.domain),
      );
      const unchecked = domains.filter(d => !freeChecked.has(d));
      if (unchecked.length) {
        throw new Error(`free_check_first: run drops_toxicity on these first (anchorsOnly needs no network): ${unchecked.join(", ")}`);
      }
      const creds = await resolveAiCreds(userId, args, "dropsHistory");
      if (!creds.aiApiKey) throw new Error("no_ai_creds: configure an AI provider in settings");
      const results: { domain: string; verdict?: string; note?: string; error?: string }[] = [];
      for (const domain of domains) {
        // Stored Wayback profile first — same rule the UI route follows: CDX is the endpoint
        // the archive throttles, so numbers already on the row are never re-asked for.
        const stored = await storedWaybackTimestamps(userId, domain);
        const snapshots = stored
          ? ({ ok: true, timestamps: stored } as const)
          : await fetchSnapshotTimestamps(domain);
        if (!snapshots.ok) {
          results.push({ domain, error: snapshots.reason === "throttled" ? "wayback_throttled" : "wayback_unreachable" });
          continue;
        }
        const verdict = await analyseDomainHistory(domain, snapshots.timestamps, {
          aiProvider: creds.aiProvider, aiApiKey: creds.aiApiKey, model: creds.model, aiBaseUrl: creds.aiBaseUrl,
        }, fetchLLM);
        if (!verdict) { results.push({ domain, error: "not_a_domain" }); continue; }
        await setHistoryVerdict(userId, domain, verdict.verdict, verdict.note);
        results.push({ domain, verdict: verdict.verdict, note: verdict.note });
      }
      return { results };
    },
  },

  {
    name: "drops_toxicity",
    cost: "net",
    idempotent: false,
    description:
      "Run one bounded slice of the FREE toxicity classifier over the catalogue — the same slice the /drops button runs (historyVerdict: clean | empty | suspicious | toxic written in shadow mode; score and veto untouched unless the arm flag is on). Sources in order: topAnchors already on the row (anchorsOnly: true = the whole catalogue with ZERO network requests), then a Wayback walk (CDX + up to N snapshots per domain through the proxy pool's web.archive.org zone). 429/503 from the archive is never a verdict — the row sits out 6h and is listed in skipped. Returns { checked, toxic, suspicious, clean, empty, remaining, done, skipped } — call repeatedly while remaining > 0.",
    inputSchema: {
      type: "object",
      properties: {
        domains: { type: "array", items: { type: "string" }, description: "up to 25 explicit domains" },
        filter: { type: "object", description: "drops_list-shaped filter, alternative to domains" },
        snapshots: { type: "number", description: "snapshots per domain, 1..5, default 3" },
        anchorsOnly: { type: "boolean", description: "true = classify by topAnchors + name scan only, no network at all" },
        runId: { type: "string" },
        batch: { type: "number", description: "rows this slice, default 8 (25 with anchorsOnly)" },
      },
    },
    handler: async (userId, args) => {
      const domains = domainsArg(args).slice(0, 25);
      const filter = !domains.length && args.filter && typeof args.filter === "object"
        ? parseCandidateFilter(args.filter as Record<string, unknown>)
        : undefined;
      return runToxSlice(userId, {
        domains: domains.length ? domains : undefined,
        filter,
        anchorsOnly: args.anchorsOnly === true,
        runId: typeof args.runId === "string" && args.runId ? args.runId : undefined,
        batch: args.batch !== undefined ? lim(args.batch, 1, args.anchorsOnly === true ? 200 : 25) : undefined,
        snapshots: lim(args.snapshots, 3, 5),
      });
    },
  },

  {
    name: "glue_plan",
    cost: "local",
    description:
      "Build the hreflang/canonical annotation blocks that glue a dropped domain to a money site — the generator behind the «Склейка» card on /drops?tab=activation. One cluster, one mode: 'cluster' (mutual, each page canonical to itself — nothing merges, nothing falls off) or 'funnel' (every canonical points at the drop — signals merge into it, and the drop's owner controls your rankings; that trade-off is the scheme's whole point). Returns per-page <html lang>, canonical, the shared alternate set (self-reference included — without it Google drops the group) and a ready-to-paste <head> block. Notes (locale_fixed, locale_duplicate, url_not_absolute, …) come back verbatim: they say exactly what was corrected in the input.",
    inputSchema: {
      type: "object",
      required: ["mode", "dropUrl", "alternates"],
      properties: {
        mode: { type: "string", description: "cluster | funnel" },
        dropUrl: { type: "string", description: "the drop, absolute URL" },
        alternates: { type: "array", items: { type: "object" }, description: "[{ hreflang, url }] — locales and their money-page URLs" },
        xDefault: { type: "string", description: "x-default target, defaults to the drop" },
        dropHtmlLang: { type: "string", description: "<html lang> for the drop page, defaults to the first locale's language" },
      },
    },
    handler: async (_userId, args) => {
      const mode = args.mode === "funnel" ? "funnel" : "cluster" as GlueMode;
      const alternates = (Array.isArray(args.alternates) ? args.alternates : [])
        .filter((a): a is { hreflang: string; url: string } =>
          !!a && typeof a === "object" && typeof (a as { hreflang?: unknown }).hreflang === "string" && typeof (a as { url?: unknown }).url === "string")
        .slice(0, 12)
        .map(a => ({ hreflang: a.hreflang, url: a.url }));
      const spec: GlueSpec = {
        mode,
        dropUrl: typeof args.dropUrl === "string" ? args.dropUrl : "",
        alternates,
      };
      if (typeof args.xDefault === "string" && args.xDefault) spec.xDefault = args.xDefault;
      if (typeof args.dropHtmlLang === "string" && args.dropHtmlLang) spec.dropHtmlLang = args.dropHtmlLang;
      return buildGluePlan(spec);
    },
  },

  {
    name: "glue_check",
    cost: "net",
    description:
      "Check a LIVE glue cluster: fetches every page (safeFetch, manual redirects, ≤5 hops), parses canonical/alternate/noindex from the final response and runs the validator — reciprocity, self-reference, x-default, dead or noindex targets, and with a plan also a live-vs-plan diff (a swapped canonical on your money page). ua: 'both' adds the Googlebot pass and flags cloaked_annotations when browser and bot see different annotations. LIMITATION you must carry into any conclusion: the UA diff only catches User-Agent-based cloaking. Serious setups cloak by IP with reverse-DNS verification — a Googlebot-UA request from a foreign address gets the plain page, so an EMPTY cloaked_annotations finding does NOT prove the absence of cloaking.",
    inputSchema: {
      type: "object",
      required: ["mode", "urls"],
      properties: {
        mode: { type: "string", description: "cluster | funnel (in funnel, hreflang→non-canonical is info, not a blocker — that IS the mechanism)" },
        urls: { type: "array", items: { type: "string" }, description: "up to 10 absolute URLs, both sides of the cluster" },
        plan: { type: "object", description: "the glue_plan output — when present, live pages are also diffed against it" },
        ua: { type: "string", description: "browser (default) | googlebot | both" },
      },
    },
    handler: async (_userId, args) => {
      const mode: GlueMode = args.mode === "funnel" ? "funnel" : "cluster";
      const urls = (Array.isArray(args.urls) ? args.urls : [])
        .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim()))
        .slice(0, 10);
      if (!urls.length) throw new Error("urls required (absolute http(s), up to 10)");
      const ua = args.ua === "googlebot" || args.ua === "both" ? args.ua : "browser";
      const plan = args.plan && typeof args.plan === "object" && Array.isArray((args.plan as GluePlan).pages)
        ? (args.plan as GluePlan)
        : undefined;

      const pages = await fetchClusterPages(urls, { ua: "browser" });
      const facts = pages.map(parsePage);
      let report = validateCluster(facts, { mode, plan });

      let botFacts;
      if (ua === "googlebot" || ua === "both") {
        const botPages = await fetchClusterPages(urls, { ua: "googlebot" });
        botFacts = botPages.map(parsePage);
        report = ua === "googlebot"
          ? validateCluster(botFacts, { mode, plan })
          : withFindings(report, detectCloaking(facts, botFacts));
      }
      return { report, facts, botFacts };
    },
  },

  {
    name: "drops_watch",
    cost: "local",
    idempotent: false,
    description:
      "Watch taken (registered) domains from the catalogue and get told when one becomes free. Watched rows are re-checked by the in-app scheduler (default daily; 15 min once the registry reports pendingDelete, 60 min on redemptionPeriod); a corroborated free verdict sends ONE Telegram/Slack notification (Settings → Notifications) and ends that watch — an uncorroborated one is silently re-checked within the hour instead. Rows must have passed the funnel's DNS + registry stages to be watched meaningfully. `watch: true` makes rows due immediately; without `watch`, returns the current watchlist with the count.",
    inputSchema: {
      type: "object",
      properties: {
        watch: { type: "boolean", description: "true = start watching, false = stop watching; omit to list" },
        domains: { type: "array", items: { type: "string" }, description: "domains to (un)watch, max 200" },
      },
    },
    handler: async (userId, args) => {
      const domains = domainsArg(args).slice(0, 200);
      if (typeof args.watch !== "boolean") {
        const page = await listCandidates(userId, { watched: true, limit: 200, orderBy: "domain", orderDir: "asc" });
        return {
          watched: await countWatched(userId),
          rows: (page.rows as Record<string, unknown>[]).map(row),
        };
      }
      if (!domains.length) throw new Error("domains required when watch is true/false");
      const updated = await setWatchedByDomains(userId, domains, args.watch);
      return {
        updated,
        watched: await countWatched(userId),
        note: args.watch
          ? "rows are due on the next scheduler tick (≤5 min); alerts go to Telegram/Slack from Settings → Notifications"
          : undefined,
      };
    },
  },
];
