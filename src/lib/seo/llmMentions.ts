// Brand visibility inside AI answers, via DataForSEO's LLM Mentions index.
//
// This is a **second source** for the AEO Tracker, not a replacement, and the difference between
// the two is the reason both exist:
//
//   AEO Tracker (aeo.ts)   asks YOUR question to a live model on YOUR API key, today, and
//                          records whether you were cited. Exact, current, and scoped to the
//                          questions you thought to track.
//   LLM Mentions (here)    reads DataForSEO's own index of what models have been answering.
//                          It covers questions you never thought of, ranks the pages that get
//                          cited, and can compare you against competitors — but it is an index
//                          refreshed roughly monthly, not a live answer.
//
// A drop in the live tracker means "we stopped being cited for this question". A drop here means
// "the brand is losing ground across the whole surface". Reporting either as the other would be
// wrong, so the UI keeps them side by side and labelled.
//
// Coverage is narrower than the live tracker: DataForSEO indexes ChatGPT and Google AI Overview.
// Claude and Grok exist only in the live tracker, which is another reason not to merge them.

import { locationCode, isSupportedCountry } from "./demand";

const DFS_BASE = "https://api.dataforseo.com";
const DFS_TIMEOUT_MS = 60_000;

/** The only two surfaces DataForSEO indexes. Not an abbreviation of a longer list. */
export type LlmPlatform = "chat_gpt" | "google";
export const LLM_PLATFORMS: LlmPlatform[] = ["chat_gpt", "google"];

export const PLATFORM_LABEL: Record<LlmPlatform, string> = {
  chat_gpt: "ChatGPT",
  google: "Google AI Overview",
};

/** Live endpoints, flat-priced per call rather than per row. */
const MENTIONS_CALL_COST = 0.02;

export interface MentionRow {
  /** The question a model was answering when the brand came up. */
  question: string;
  /** How often that question is asked of AI, DataForSEO's own estimate. */
  aiSearchVolume: number | null;
  sources: { url: string; title: string; domain: string }[];
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface MentionTotals {
  platform: LlmPlatform;
  mentions: number;
  aiSearchVolume: number;
  impressions: number;
}

export interface TopPage {
  url: string;
  mentions: number;
  aiSearchVolume: number;
}

export interface ShareRow {
  /** The label the caller asked for — normally a brand or domain. */
  brand: string;
  mentions: number;
  aiSearchVolume: number;
  /** Share of the whole compared set, 0..1. Computed here, not returned by the API. */
  share: number;
}

export interface MentionsResult {
  totals: MentionTotals[];
  mentions: MentionRow[];
  topPages: TopPage[];
  cost: number;
  error?: string;
}

function dfsAuth(cred: string): string {
  const c = (cred || "").trim();
  return c.includes(":") ? Buffer.from(c).toString("base64") : c;
}

async function post<T = any>(
  credential: string,
  path: string,
  body: unknown,
  pick: (task: any) => T,
): Promise<{ data: T | null; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`${DFS_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Basic ${dfsAuth(credential)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DFS_TIMEOUT_MS),
    });
  } catch (e: any) {
    return { data: null, error: `сеть DataForSEO: ${e?.cause?.code || e?.message || "fetch failed"}` };
  }
  if (!res.ok) return { data: null, error: `dataforseo ${res.status}: ${(await res.text()).slice(0, 200)}` };

  let json: any;
  try { json = await res.json(); } catch { return { data: null, error: "dataforseo: ответ не JSON" }; }

  if (json?.status_code && json.status_code !== 20000) {
    return { data: null, error: `dataforseo ${json.status_code}: ${json.status_message}` };
  }
  const task = json?.tasks?.[0];
  if (task?.status_code && task.status_code !== 20000) {
    return { data: null, error: `dataforseo task ${task.status_code}: ${task.status_message}` };
  }
  return { data: pick(task) };
}

/**
 * A brand can be watched by domain or by name, and the two answer different questions.
 *
 * By domain finds answers that *linked* to you — hard evidence, but it misses every time a model
 * named the brand without a citation. By keyword finds the name in the text, including in
 * `brand_entities`, which is where a mention with no link shows up. Neither alone is the answer,
 * so the caller picks and the UI says which one produced the number.
 */
function targetFor(kind: "domain" | "brand", value: string) {
  return kind === "domain"
    ? [{ domain: value, include_subdomains: true, search_filter: "include", search_scope: ["any"] }]
    : [{ keyword: value, search_filter: "include", search_scope: ["any", "brand_entities"], match_type: "word_match" }];
}

/** Group elements come back as `[{ key: "chat_gpt", mentions, ... }]`; flatten to one row per platform. */
function readGroups(arr: any[] | null | undefined): { key: string; mentions: number; volume: number; impressions: number }[] {
  return (arr ?? []).map((g: any) => ({
    key: String(g?.key ?? ""),
    mentions: Number(g?.mentions ?? 0),
    volume: Number(g?.ai_search_volume ?? 0),
    impressions: Number(g?.impressions ?? 0),
  }));
}

/**
 * Everything the index knows about one brand on one platform: how often it comes up, the actual
 * questions it comes up in, and which of its pages get cited.
 *
 * Three calls, run in sequence rather than in parallel — DataForSEO throttles the AI endpoints
 * harder than Labs, and a 429 halfway through would leave a partial result that still billed for
 * what succeeded. Failures are returned, not thrown: totals alone are a useful answer.
 */
export async function brandMentions(
  credential: string,
  opts: {
    kind: "domain" | "brand";
    value: string;
    platform: LlmPlatform;
    gl?: string;
    hl?: string;
    limit?: number;
  },
): Promise<MentionsResult> {
  const blank: MentionsResult = { totals: [], mentions: [], topPages: [], cost: 0 };
  if (!credential) return { ...blank, error: "no_key" };
  if (!opts.value.trim()) return { ...blank, error: "no_target" };

  const gl = opts.gl || "us";
  if (!isSupportedCountry(gl)) return { ...blank, error: `unsupported_country:${gl}` };

  const target = targetFor(opts.kind, opts.value.trim());
  const base = {
    target,
    platform: opts.platform,
    location_code: locationCode(gl),
    language_code: opts.hl || "en",
  };

  let cost = 0;

  const agg = await post(
    credential,
    "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
    [{ ...base, internal_list_limit: 10 }],
    (task) => task?.result?.[0]?.total ?? {},
  );
  if (agg.error) return { ...blank, error: agg.error };
  cost += MENTIONS_CALL_COST;

  const totals: MentionTotals[] = readGroups(agg.data?.platform)
    .filter(g => g.key === "chat_gpt" || g.key === "google")
    .map(g => ({
      platform: g.key as LlmPlatform,
      mentions: g.mentions,
      aiSearchVolume: g.volume,
      impressions: g.impressions,
    }));

  // Nothing indexed for this brand is a complete answer. The two remaining calls would each cost
  // a flat fee to return empty arrays.
  if (!totals.some(t => t.mentions > 0)) return { ...blank, totals, cost };

  const search = await post(
    credential,
    "/v3/ai_optimization/llm_mentions/search/live",
    [{ ...base, limit: Math.max(10, Math.min(1000, opts.limit ?? 100)) }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (!search.error) cost += MENTIONS_CALL_COST;

  const mentions: MentionRow[] = (search.data ?? []).map((m: any) => ({
    question: String(m?.question ?? ""),
    aiSearchVolume: m?.ai_search_volume ?? null,
    sources: (m?.sources ?? []).map((s: any) => ({
      url: String(s?.url ?? ""),
      title: String(s?.title ?? ""),
      domain: String(s?.domain ?? ""),
    })).filter((s: any) => s.url),
    firstSeen: m?.first_response_at ?? null,
    lastSeen: m?.last_response_at ?? null,
  })).filter((m: MentionRow) => m.question);

  const pages = await post(
    credential,
    "/v3/ai_optimization/llm_mentions/top_pages/live",
    [{ ...base, links_scope: "sources", items_list_limit: 10, internal_list_limit: 5 }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (!pages.error) cost += MENTIONS_CALL_COST;

  const topPages: TopPage[] = (pages.data ?? []).map((p: any) => {
    const g = readGroups(p?.platform).find(x => x.key === opts.platform) ?? { mentions: 0, volume: 0 };
    return { url: String(p?.key ?? ""), mentions: g.mentions, aiSearchVolume: g.volume };
  }).filter((p: TopPage) => p.url);

  return {
    totals,
    mentions: mentions.sort((a, b) => (b.aiSearchVolume ?? 0) - (a.aiSearchVolume ?? 0)),
    topPages: topPages.sort((a, b) => b.mentions - a.mentions),
    cost,
    error: search.error || pages.error,
  };
}

/**
 * Share of voice: you against 1–9 competitors in one call.
 *
 * This is the number the live AEO tracker structurally cannot produce. It knows whether you were
 * cited for your own tracked questions; it has no way to know how often a competitor was cited
 * instead, because it never asked on the competitor's behalf. One cross-aggregated call answers
 * that for the whole set at once.
 *
 * `share` is computed here rather than read from the response — the API returns absolute counts
 * per group, and the only meaningful reading of "share" is against the set the user chose to
 * compare, which is a decision the API knows nothing about.
 */
export async function shareOfVoice(
  credential: string,
  opts: {
    kind: "domain" | "brand";
    /** The user's own brand first; order is preserved in the result. */
    values: string[];
    platform: LlmPlatform;
    gl?: string;
    hl?: string;
  },
): Promise<{ rows: ShareRow[]; cost: number; error?: string }> {
  if (!credential) return { rows: [], cost: 0, error: "no_key" };

  const values = [...new Set(opts.values.map(v => v.trim()).filter(Boolean))];
  // The endpoint's own limits, worth failing on explicitly: one group has nothing to compare
  // against, and above ten the API rejects the whole request.
  if (values.length < 2) return { rows: [], cost: 0, error: "need_two" };
  if (values.length > 10) return { rows: [], cost: 0, error: "too_many" };

  const gl = opts.gl || "us";
  if (!isSupportedCountry(gl)) return { rows: [], cost: 0, error: `unsupported_country:${gl}` };

  const res = await post(
    credential,
    "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
    [{
      targets: values.map(v => ({ aggregation_key: v, target: targetFor(opts.kind, v) })),
      platform: opts.platform,
      location_code: locationCode(gl),
      language_code: opts.hl || "en",
      internal_list_limit: 5,
    }],
    (task) => task?.result?.[0]?.items ?? [],
  );
  if (res.error) return { rows: [], cost: 0, error: res.error };

  const raw = (res.data ?? []).map((item: any) => {
    const g = readGroups(item?.platform).find(x => x.key === opts.platform) ?? { mentions: 0, volume: 0 };
    return { brand: String(item?.key ?? ""), mentions: g.mentions, aiSearchVolume: g.volume };
  }).filter((r: any) => r.brand);

  const total = raw.reduce((s: number, r: any) => s + r.mentions, 0);
  const byBrand = new Map(raw.map((r: any) => [r.brand, r]));

  // Ordered by the caller's list, not by the API's: the user's own brand is first, and a brand
  // the index has never seen must still appear as a zero rather than silently vanish.
  const rows: ShareRow[] = values.map(v => {
    const r = byBrand.get(v) as { mentions: number; aiSearchVolume: number } | undefined;
    return {
      brand: v,
      mentions: r?.mentions ?? 0,
      aiSearchVolume: r?.aiSearchVolume ?? 0,
      share: total > 0 ? (r?.mentions ?? 0) / total : 0,
    };
  });

  return { rows, cost: MENTIONS_CALL_COST };
}

/** What a full brand lookup costs at most: aggregated + search + top pages. */
export const BRAND_LOOKUP_COST = MENTIONS_CALL_COST * 3;
export const SHARE_OF_VOICE_COST = MENTIONS_CALL_COST;
