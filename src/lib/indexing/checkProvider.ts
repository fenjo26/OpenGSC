// Provider layer for URL index checks — the two engines a SerpCheckRun item can run on.
//
//   xmlriver  XML River's dedicated search_console endpoint: a direct "is this URL indexed"
//             answer, billed per check on the operator's own tariff. Cheaper than a site: SERP
//             query for the same question, which is why it is its own provider here and not a
//             runSerp engine (runSerp providers answer search queries; XR answers the verdict).
//   any other the user's SERP provider via getUserSerpCreds (serper, dataforseo, scrapingrobot,
//             aparser) — the site: estimation path from serpIndex.ts, unchanged semantics.
//
// Both engines answer in the same verdict vocabulary as SitemapUrl.serpIndex*, and the one rule
// holds for both (CONTRACT §0.5, the SERP Monitor contract): a provider failure — captcha, auth,
// network, non-2xx — is `error`, NEVER `not_indexed`. A mis-read captcha would tell the operator
// their page fell out of the index.

import { prisma } from "@/lib/prisma";
import { loggedFetch } from "@/lib/providerLog/log";
import { getUserSerpCreds, type SerpCreds } from "@/lib/rank";
import { runSerp } from "@/lib/seo/serp";
import { estimateSerpQueryCost, usdToUnits } from "@/lib/plagiarism/price";
import { classifySerpIndex, siteQueryFor, type SerpIndexStatus } from "@/lib/indexing/serpIndex";

export const XMLRIVER = "xmlriver";

export interface XmlRiverCreds {
  userId: string;
  apiKey: string;
}

export interface IndexCheckOutcome {
  status: SerpIndexStatus;
  /** The SERP URL that matched (set on `indexed` via the site: engine; XR has no match URL). */
  matchedUrl: string | null;
  /** Provider error text (set on `error`). */
  detail: string | null;
}

/** Politeness gaps between paid calls — XR matches xr-donors, the site: path matches the panel. */
export const XR_PAUSE_MS = 300;
export const SERP_PAUSE_MS = 800;

/**
 * XML River's answer, normalised. Shapes seen across their API and our three integrations
 * (validate route, xr-donors, the legacy panel button): a top-level `error`, or the verdict as
 * `indexed` — sometimes nested `content.indexed` / `content.index: "yes"`. Anything the parser
 * does not recognise as indexed and that carries no error is an honest not_indexed: the API
 * answered and said no.
 */
export function parseXmlRiverVerdict(data: unknown): IndexCheckOutcome {
  const root = asRecord(data);
  if (!root) return { status: "error", matchedUrl: null, detail: "bad_response" };
  if (root.error != null && root.error !== "") {
    return { status: "error", matchedUrl: null, detail: String(root.error).slice(0, 200) };
  }
  const content = asRecord(root.content);
  const indexed =
    root.indexed === true ||
    content?.indexed === true ||
    content?.index === "yes";
  return indexed
    ? { status: "indexed", matchedUrl: null, detail: null }
    : { status: "not_indexed", matchedUrl: null, detail: null };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** One URL against XML River's search_console endpoint. Never throws — every failure is `error`. */
export async function checkUrlXmlRiver(creds: XmlRiverCreds, url: string): Promise<IndexCheckOutcome> {
  const apiUrl = `https://xmlriver.com/search_console/json/?user=${encodeURIComponent(creds.userId)}&key=${encodeURIComponent(creds.apiKey)}&url=${encodeURIComponent(url)}`;
  try {
    const { res, call } = await loggedFetch(apiUrl, { signal: AbortSignal.timeout(10_000) }, { provider: XMLRIVER });
    const data: unknown = await res.json().catch(() => null);
    const outcome: IndexCheckOutcome = res.ok
      ? parseXmlRiverVerdict(data)
      : { status: "error", matchedUrl: null, detail: `http ${res.status}` };
    call.finish(
      outcome.status === "error"
        ? { error: outcome.detail ?? "error", responseBody: data as Record<string, unknown> | null }
        : { responseBody: data as Record<string, unknown> | null },
    );
    return outcome;
  } catch (e) {
    return { status: "error", matchedUrl: null, detail: e instanceof Error ? e.message.slice(0, 200) : "network" };
  }
}

/** One URL through the site: estimation path — the same query and classifier as the sync panel. */
export async function checkUrlSerp(creds: SerpCreds, url: string): Promise<IndexCheckOutcome> {
  const query = siteQueryFor(url);
  if (!query) return { status: "error", matchedUrl: null, detail: "invalid_url" };
  const opts: Parameters<typeof runSerp>[3] = {
    num: 10,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    ...(creds.configPreset ? { configPreset: creds.configPreset } : {}),
  };
  const serp = await runSerp(creds.provider, creds.apiKey, query, opts);
  if (serp.error) {
    // Captcha, auth, network — an error, never a verdict (see the file header).
    return {
      status: "error",
      matchedUrl: null,
      detail: serp.errorDetail ? `${serp.error} (${serp.errorDetail.slice(0, 120)})` : serp.error,
    };
  }
  return { ...classifySerpIndex(url, serp.results, null), detail: null };
}

/** The resolved engine for a run: XR creds, or the user's configured SERP provider. */
export type IndexCheckCreds =
  | { engine: "xmlriver"; xr: XmlRiverCreds }
  | { engine: "serp"; serp: SerpCreds };

/**
 * Resolve the checking credentials. `wanted` is "" (the user's SERP provider from settings) or
 * "xmlriver". The returned `engine`/provider name is what gets stamped on the run and its items.
 */
export async function getIndexCheckCreds(userId: string, wanted: string): Promise<IndexCheckCreds | null> {
  if (wanted === XMLRIVER) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { xmlRiverUserId: true, xmlRiverApiKey: true },
    });
    if (user?.xmlRiverUserId && user?.xmlRiverApiKey) {
      return { engine: "xmlriver", xr: { userId: user.xmlRiverUserId, apiKey: user.xmlRiverApiKey } };
    }
    return null;
  }
  const serp = await getUserSerpCreds(userId);
  return serp ? { engine: "serp", serp } : null;
}

export interface IndexCheckEstimate {
  provider: string;
  queries: number;
  costUsd: number | null;
  /** Price per single check, when known — the queue records exactly this many units per item. */
  perCheckUsd: number | null;
  free: boolean;
  unknownPrice: boolean;
}

/**
 * The budget half shown BEFORE any spend (the estimate branch of the create route). XML River
 * prices from the operator's own tariff field — empty means we honestly do not know: count-only,
 * unknownPrice, no units recorded. SERP providers price from the shared table.
 */
export async function estimateIndexCheck(
  userId: string,
  wanted: string,
  count: number,
): Promise<IndexCheckEstimate & { error?: string }> {
  if (wanted === XMLRIVER) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { xmlRiverUserId: true, xmlRiverApiKey: true, xmlRiverPriceUsd: true },
    });
    if (!user?.xmlRiverUserId || !user?.xmlRiverApiKey) {
      return { provider: XMLRIVER, queries: count, costUsd: null, perCheckUsd: null, free: false, unknownPrice: true, error: "no_xr_key" };
    }
    const per = user.xmlRiverPriceUsd;
    if (per != null && per > 0) {
      return {
        provider: XMLRIVER,
        queries: count,
        costUsd: Math.round(count * per * 1e6) / 1e6,
        perCheckUsd: per,
        free: false,
        unknownPrice: false,
      };
    }
    // Tariff not filled in: the run still works, the budget is honestly "по тарифу XR".
    return { provider: XMLRIVER, queries: count, costUsd: null, perCheckUsd: null, free: false, unknownPrice: true };
  }
  const creds = await getUserSerpCreds(userId);
  if (!creds) {
    return { provider: "", queries: count, costUsd: null, perCheckUsd: null, free: false, unknownPrice: false, error: "no_serp_key" };
  }
  const price = estimateSerpQueryCost(creds.provider, count);
  const perCheckUsd = price.costUsd != null && count > 0 ? price.costUsd / count : null;
  return { provider: creds.provider, queries: count, perCheckUsd, ...price };
}

/** Units to record for one answered-or-attempted check — 0 when the price is unknown. */
export function perCheckUnits(est: IndexCheckEstimate): number {
  return est.perCheckUsd != null ? usdToUnits(est.perCheckUsd) : 0;
}
