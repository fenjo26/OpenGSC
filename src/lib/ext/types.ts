// wave-ext — wire shapes of the extension API. Pure types and constants; no imports from Prisma.
import type { DomainTag } from "@/lib/serpmon/types";
import type { MetaFitResult } from "@/lib/seo/metaLimits";

// ─── limits ──────────────────────────────────────────────────────────────────
export const EXT_HOSTS_MAX = 100;            // hosts per /api/ext/hosts call
export const EXT_CAPTURE_ROWS_MAX = 100;     // organic rows per capture
export const EXT_ENRICH_MAX = 20;            // hosts per /api/ext/hosts/enrich call
export const EXT_ENRICH_DEADLINE_MS = 20_000;
export const EXT_CLOAK_PER_MIN = 6;          // extra per-token limit on /api/ext/cloak
export const EXT_CAPTURE_DEDUPE_MS = 10 * 60_000; // same user+keyword+engineHost+page → update, not insert
export const EXT_QUERY_WINDOW_DAYS = 28;
export const EXT_SNIPPET_MAX = 300;
export const EXT_TITLE_MAX = 200;

// ─── /api/ext/lists (E0) ─────────────────────────────────────────────────────
export interface ListsResponse {
  sites: { id: string; label: string }[];
  projects: { id: string; name: string; country: string; lang: string }[];
}

// ─── /api/ext/hosts ──────────────────────────────────────────────────────────
export interface HostsRequest {
  hosts: string[];          // ≤ EXT_HOSTS_MAX; any form — server normalises with hostOfUrl()
  query?: string;           // the SERP query, when called from the overlay
  country?: string;         // gl, "" when unknown
  lang?: string;            // hl, "" when unknown
}

export interface HostSerpmon {
  projectId: string;
  projectName: string;
  keywords: number;         // SerpProjectHost.keywords
  top10: number;
  bestPos: number | null;
  firstSeenAt: string;      // ISO
  tags: DomainTag[];
}

export interface HostLinksToUs {
  siteId: string;           // Site.id
  label: string;            // host of the site, no scheme
  links: number;            // SiteBacklink rows with domainFrom = this host (apex match)
  live: number;             // of them not apiLost
}

export interface HostIntel {
  host: string;             // normalised (hostOfUrl)
  registrable: string;      // apexOf(host); "" when unknown
  own: { siteId: string; label: string; openPath: string } | null;     // a portfolio site
  ownPbn: { pbnSiteId: string; status: string } | null;                // PbnSite.domain = registrable
  dr: number | null;
  drSource: "serpmon" | "metric_cache" | "dr_cache" | null;            // where `dr` came from
  drCheckedAt: string | null;
  refdomains: number | null;
  ageMonths: number | null; // calcAgeMonths(SerpHost.registeredAt)
  serpmon: HostSerpmon[];   // ≤ 3, projects matching country/lang first (all projects when unknown)
  linksToUs: HostLinksToUs[];
  outreach: { prospectId: string; stage: string } | null;
  drops: { candidateId: string; stage: string; watched: boolean } | null;
  asset: { assetId: string; stage: string } | null;                    // DropAsset (bought drop)
}

export interface QueryOwnRow {
  siteId: string;
  label: string;
  url: string;
  clicks: number;
  impressions: number;
  position: number;         // impression-weighted over the window, 1 decimal
}

export interface QueryIntel {
  query: string;            // normaliseKeyword()
  windowDays: number;       // EXT_QUERY_WINDOW_DAYS
  own: QueryOwnRow[];       // QueryPageDaily rows of this exact query, any portfolio site
  tracked: { siteId: string; label: string; keywordId: string; lastPosition: number | null; lastUrl: string | null; lastCheckedAt: string | null }[];
  serpmon: { projectId: string; projectName: string; keywordId: string; lastStatus: string; lastOkAt: string | null; lastRunStorm: boolean }[];
  metrics: { volume: number | null; difficulty: number | null; cpc: number | null; checkedAt: string } | null; // KeywordMetricCache only — never fetched
}

export interface HostsResponse {
  hosts: HostIntel[];       // same order as the request, de-duplicated
  query: QueryIntel | null; // null when no `query` was sent
  missing: { age: number; dr: number };  // hosts whose age / DR are unknown — "fill in for free"
  notMigrated?: true;
}

// ─── /api/ext/hosts/enrich ───────────────────────────────────────────────────
export interface EnrichRequest { hosts: string[] }           // ≤ EXT_ENRICH_MAX
export interface EnrichResponse { age: number; dr: number; errors: number; remaining: number }

// ─── /api/ext/serp/capture ───────────────────────────────────────────────────
export const CAPTURE_FEATURES = ["ai_overview", "paa", "local_pack", "top_stories", "video", "images", "shopping", "knowledge_panel", "sitelinks"] as const;
export type CaptureFeature = (typeof CAPTURE_FEATURES)[number];

export interface CaptureResult {
  position: number;         // absolute (startPos-based)
  url: string;
  title: string;            // ≤ EXT_TITLE_MAX
  snippet: string;          // ≤ EXT_SNIPPET_MAX
}

export interface CaptureRequest {
  query: string;
  engineHost: string;
  country: string;
  lang: string;
  device: "desktop" | "mobile";
  page: number;
  startPos: number;
  results: CaptureResult[]; // ≤ EXT_CAPTURE_ROWS_MAX
  features: string[];       // unknown values are dropped server-side
  note?: string;
}

export interface CaptureResponse {
  ok: true;
  captureId: string;
  updated: boolean;         // true when an EXT_CAPTURE_DEDUPE_MS duplicate was overwritten
  projectId: string | null;
  keywordId: string | null;
  newHosts: number;         // SerpHost rows created by this capture
}

// ─── /api/ext/serp/action ────────────────────────────────────────────────────
export type SerpAction =
  | { kind: "rank_track"; query: string; siteId: string; country: string; lang: string; device: "desktop" | "mobile" }
  | { kind: "serpmon_keyword"; query: string; projectId: string }
  | { kind: "drops_watch"; host: string };

export type SerpActionResponse =
  | { ok: true; kind: "rank_track"; added: boolean; keywordId: string | null }
  | { ok: true; kind: "serpmon_keyword"; added: boolean }
  | { ok: true; kind: "drops_watch"; inserted: boolean; watched: boolean; domain: string };

// ─── /api/ext/cloak ──────────────────────────────────────────────────────────
export interface CloakRequest { url: string; title?: string; snippet?: string }
export type CloakVerdict = "same" | "differs" | "blocked" | "error";
export interface CloakView {
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  snippetFound: boolean | null;   // null when no snippet was sent or the body is empty
}
export interface CloakResponse {
  verdict: CloakVerdict;
  reasons: string[];        // machine codes from diffViews + "snippet_only_bot" | "snippet_only_browser" | "anti_bot:<name>"
  bot: CloakView;           // Googlebot UA
  browser: CloakView;       // desktop browser UA
  checkedAt: string;
}

// ─── /api/ext/insights (E2) ──────────────────────────────────────────────────
export interface InsightsRequest {
  url: string;
  title: string;            // as on the live page
  description: string;
  h1: string;               // first H1 text
}

export interface FootprintHit {
  kind: "title" | "description" | "h1";
  skeleton: string;         // this page's skeleton, "{x}" for entities
  matches: { siteLabel: string; url: string; text: string; similarity: number }[]; // ≤ 5, other sites only
}

export interface InsightsResponse {
  inPortfolio: boolean;
  mainQuery: { query: string; clicks: number; impressions: number; position: number } | null; // top query by clicks over EXT_QUERY_WINDOW_DAYS
  titleMatchesMainQuery: boolean | null;  // pageMatchesQuery(title, h1, mainQuery.query); null without a main query
  inSitemap: boolean | null;              // active SitemapUrl row exists; null when the site has no sitemap inventory at all
  meta: { title: MetaFitResult | null; description: MetaFitResult | null }; // fitMetaLocal (free, code-only); null when the live value is already inBand or there is no main query
  footprint: FootprintHit[];              // only kinds that have matches
  notMigrated?: true;
}

// ─── /api/ext/meta-fit (E2) ──────────────────────────────────────────────────
export interface ExtMetaFitRequest {
  url: string;
  title: string;
  description: string;
  language?: string;        // page <html lang>, "" when unknown
  allowLlm?: boolean;       // false = pure string work ("act"); true = up to 2 repair calls ("spend")
  confirm?: boolean;        // required with allowLlm
}
export interface ExtMetaFitResponse { title: MetaFitResult | null; description: MetaFitResult | null; llmCalls: number }
