// PageSpeed Insights for the audit — a sample, not a site census.
//
// The audit crawls up to 5000 pages; PSI takes tens of seconds per URL, so measuring every
// page would make the audit about Lighthouse. Instead: the home page plus one representative
// per template (first path segment with ≥ 3 pages, the internally most-linked page inside it),
// at most PSI_SAMPLE_MAX URLs. That answers "how fast does this site feel on a phone" for one
// external-call budget, and cwv_poor deliberately does not affect the health score — five
// pages are a sample, not the site.
//
// The stage never holds the audit: no key → status "unavailable" (shown as text, not an
// error); a slow or timed-out run → status "partial" with whatever did come back.

import { safeFetch } from "@/lib/security/safeFetch";
import { rawQuery } from "@/lib/db/raw";
import { startProviderCall } from "@/lib/providerLog/log";

/** Hard cap on sampled URLs per audit (home + one per template). */
export const PSI_SAMPLE_MAX = 5;
export const PSI_TIMEOUT_MS = 60_000;
export const PSI_CONCURRENCY = 2;
/** A template is a real section worth sampling only when it has this many pages. */
export const PSI_TEMPLATE_MIN_PAGES = 3;

// ─── key resolution ────────────────────────────────────────────────────────────

/**
 * The PageSpeed key the user configured under Settings → API Keys → Health Check. The browser
 * keeps the working copy (localStorage `healthKey_google`) and SeoKeysSync mirrors it into
 * User.seoSettings, which is where server-side callers resolve it — the same pattern as
 * src/lib/rank.ts (`ahrefsDrApiKey`) and src/lib/digestEngines.ts. Raw SQL so it works on a
 * client generated before this column existed. Empty string = no key, which is a normal state.
 */
export async function resolvePsiApiKey(userId: string): Promise<string> {
  try {
    const rows: { seoSettings?: string | null }[] = await rawQuery(
      `SELECT seoSettings FROM "User" WHERE id = ?`, userId,
    );
    const raw = rows?.[0]?.seoSettings;
    if (!raw) return "";
    const settings = JSON.parse(raw) as Record<string, unknown>;
    return String(settings["healthKey_google"] ?? "").trim();
  } catch {
    return "";
  }
}

// ─── sampling (pure) ───────────────────────────────────────────────────────────

export interface PsiSampleInput {
  url: string;
  /** Crawl depth: 0 is the audit's start URL (possibly past redirects), i.e. the home page. */
  depth: number;
  httpStatus: number;
  hasHtml: boolean;
  noindex: boolean;
  internalInboundLinks: number;
}

/** First path segment ("/en/x" → "en"); "" for the root, which is sampled separately. */
function templateSegment(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    return segments[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Pick the sample: home first, then one page per qualifying template ordered by the
 * representative's inbound links (most central template first), capped at PSI_SAMPLE_MAX.
 * Fully deterministic — ties break on the URL — so a re-run samples the same pages.
 */
export function pickPsiSample(pages: PsiSampleInput[]): string[] {
  const candidates = pages.filter(p => p.httpStatus === 200 && p.hasHtml && !p.noindex);
  if (!candidates.length) return [];

  // Home: the audit's entry page (depth 0). Sorted by URL so concurrency in the crawl cannot
  // change the pick when http→https left two depth-0 rows.
  const home = candidates.filter(p => p.depth === 0).sort((a, b) => a.url.localeCompare(b.url))[0] ?? null;

  const byTemplate = new Map<string, PsiSampleInput[]>();
  for (const page of candidates) {
    if (home && page.url === home.url) continue;
    const segment = templateSegment(page.url);
    if (!segment) continue; // flat top-level pages: no section to represent
    const list = byTemplate.get(segment) ?? [];
    list.push(page);
    byTemplate.set(segment, list);
  }

  const representatives = [...byTemplate.entries()]
    .filter(([, list]) => list.length >= PSI_TEMPLATE_MIN_PAGES)
    .map(([, list]) => list.sort((a, b) =>
      b.internalInboundLinks - a.internalInboundLinks || a.url.localeCompare(b.url))[0])
    .sort((a, b) =>
      b.internalInboundLinks - a.internalInboundLinks || a.url.localeCompare(b.url));

  return [home, ...representatives]
    .filter((p): p is PsiSampleInput => p !== null)
    .slice(0, PSI_SAMPLE_MAX)
    .map(p => p.url);
}

// ─── response parsing (pure) ───────────────────────────────────────────────────

export interface PsiMetrics {
  source: "field" | "lab";
  /** Largest Contentful Paint, ms. */
  lcp: number | null;
  /** Interaction to Next Paint, ms — field data only (lab INP from Lighthouse is not comparable). */
  inp: number | null;
  /** Cumulative Layout Shift, unitless. */
  cls: number | null;
  /** Time to First Byte, ms — always the Lighthouse lab measurement. */
  ttfb: number | null;
  /** Performance score 0–100 from Lighthouse. */
  score: number | null;
}

interface PsiLoadingMetric {
  percentile?: number;
}

const round = (value: number | undefined | null, digits = 0): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/**
 * Field data when Google has it (`loadingExperience.metrics` non-empty), lab data otherwise.
 * Field CLS arrives in hundredths (25 = 0.25) while lab CLS is unitless — the two conventions
 * meet here, in one place, so no caller ever has to remember which is which.
 */
export function parsePsiResponse(data: unknown): PsiMetrics {
  const root = (data ?? {}) as {
    loadingExperience?: { metrics?: Record<string, PsiLoadingMetric> };
    lighthouseResult?: {
      categories?: { performance?: { score?: number | null } };
      audits?: Record<string, { numericValue?: number | null }>;
    };
  };

  const lab = root.lighthouseResult ?? {};
  const audits = lab.audits ?? {};
  const ttfb = round(audits["server-response-time"]?.numericValue);
  const score = typeof lab.categories?.performance?.score === "number"
    ? Math.round(lab.categories.performance.score * 100)
    : null;

  const field = root.loadingExperience?.metrics ?? {};
  const hasField = Object.keys(field).length > 0;
  if (hasField) {
    // INP is field-only by design; if this CrUX payload predates INP, it stays null rather
    // than borrowing the incomparable lab proxy.
    return {
      source: "field",
      lcp: round(field["LARGEST_CONTENTFUL_PAINT_MS"]?.percentile),
      inp: round(field["INTERACTION_TO_NEXT_PAINT_MS"]?.percentile),
      cls: round(field["CUMULATIVE_LAYOUT_SHIFT_SCORE"]?.percentile != null
        ? field["CUMULATIVE_LAYOUT_SHIFT_SCORE"].percentile! / 100
        : null, 3),
      ttfb,
      score,
    };
  }
  return {
    source: "lab",
    lcp: round(audits["largest-contentful-paint"]?.numericValue),
    inp: null,
    cls: round(audits["cumulative-layout-shift"]?.numericValue, 3),
    ttfb,
    score,
  };
}

// ─── poor thresholds (Google "poor" bands) ─────────────────────────────────────

export const CWV_POOR = { lcpMs: 4000, inpMs: 500, cls: 0.25 } as const;

/** Poor on any measured vital: field checks LCP/INP/CLS, lab (no INP) checks LCP/CLS. */
export function isCwvPoor(item: PsiMetrics): boolean {
  if (item.lcp != null && item.lcp > CWV_POOR.lcpMs) return true;
  if (item.inp != null && item.inp > CWV_POOR.inpMs) return true;
  if (item.cls != null && item.cls > CWV_POOR.cls) return true;
  return false;
}

// ─── the stage itself ──────────────────────────────────────────────────────────

export interface PsiItem extends PsiMetrics {
  url: string;
  error?: string;
}

export interface PsiSummary {
  status: "ok" | "partial" | "unavailable";
  items: PsiItem[];
}

/**
 * Run PageSpeed on the sample: ≤ PSI_CONCURRENCY in parallel, PSI_TIMEOUT_MS each, through
 * safeFetch (the URL is user-site-derived, so it gets the same SSRF check as every other
 * outbound call) with a provider-log row (provider "pagespeed", cost 0 — the daily quota is
 * free). The key is resolved once by the caller. Every failure becomes an item error;
 * nothing here can reject the stage.
 */
export async function runPsiStage(apiKey: string, sample: string[], onProgress?: () => void): Promise<PsiSummary> {
  if (!sample.length) return { status: "ok", items: [] };
  const items: PsiItem[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < sample.length) {
      const url = sample[cursor++];
      onProgress?.();
      try {
        // The key rides as a query parameter exactly as in /api/gsc/health; the provider log
        // stores the endpoint through safeEndpoint/redaction, which strips it.
        const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(apiKey)}`;
        const res = await safeFetch(endpoint, {
          headers: { Accept: "application/json" },
          timeoutMs: PSI_TIMEOUT_MS,
          maxBytes: 5 * 1024 * 1024,
        });
        const call = startProviderCall({ provider: "pagespeed", endpoint });
        let body: unknown = null;
        let error: string | undefined;
        if (!res.ok) {
          error = `HTTP ${res.status}`;
        } else {
          try {
            body = JSON.parse(await res.text());
          } catch {
            error = "invalid JSON response";
          }
        }
        const apiError = (body as { error?: { message?: string } } | null)?.error?.message;
        if (apiError) error = apiError.slice(0, 200);
        call.finish({ status: res.status, costUsd: 0, error: error ?? null, responseBody: body });
        if (error || !body) {
          items.push({ url, source: "lab", lcp: null, inp: null, cls: null, ttfb: null, score: null, error: error ?? "no data" });
        } else {
          items.push({ url, ...parsePsiResponse(body) });
        }
      } catch (err) {
        // safeFetch throws on timeout/transport: this page is unknown, not the whole stage.
        startProviderCall({ provider: "pagespeed", endpoint: "https://www.googleapis.com/pagespeedonline/v5/runPagespeed" })
          .finish({ status: 0, costUsd: 0, error: err instanceof Error ? err.message : String(err) });
        items.push({ url, source: "lab", lcp: null, inp: null, cls: null, ttfb: null, score: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PSI_CONCURRENCY, sample.length) }, worker));
  items.sort((a, b) => a.url.localeCompare(b.url));
  return { status: items.some(item => item.error) ? "partial" : "ok", items };
}
