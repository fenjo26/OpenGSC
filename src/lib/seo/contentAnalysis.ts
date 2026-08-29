// DataForSEO Content Analysis — Search (live). Finds citations of a brand/keyword across
// the web with sentiment polarity + emotional connotations. We build the whole feature on
// this single confirmed endpoint and compute the summary ourselves (robust).
// Docs: https://docs.dataforseo.com/v3/content_analysis/search/live/

import { loggedFetch, type CallHandle } from "@/lib/providerLog/log";

// The shapes and the emotion list live next door because the Citations page needs them in the
// browser, and this module — since its DataForSEO call became a logged one — reaches the Prisma
// client. Re-exported here so every existing server-side import is unchanged.
export * from "./contentAnalysisShapes";
import { EMOTIONS, type Citation, type Emotion, type Polarity } from "./contentAnalysisShapes";

function dfsAuth(cred: string): string {
  const c = (cred || "").trim();
  return c.includes(":") ? Buffer.from(c).toString("base64") : c;
}

function maxKey<T extends string>(obj: Record<string, number> | undefined, keys: readonly T[]): T | undefined {
  if (!obj) return undefined;
  let best: T | undefined; let bestV = -Infinity;
  for (const k of keys) { const v = Number(obj[k] ?? 0); if (v > bestV) { bestV = v; best = k; } }
  return bestV > 0 ? best : undefined;
}

export async function runContentSearch(
  credential: string,
  keyword: string,
  opts: { limit?: number } = {},
): Promise<{ total: number; items: Citation[]; error?: string }> {
  if (!credential || !keyword) return { total: 0, items: [], error: "missing" };
  const body = [{
    keyword,
    search_mode: "one_per_domain",
    order_by: ["content_info.date_published,desc"],
    limit: Math.max(10, Math.min(300, opts.limit || 100)),
  }];

  let res: Response;
  let call: CallHandle;
  try {
    ({ res, call } = await loggedFetch("https://api.dataforseo.com/v3/content_analysis/search/live", {
      method: "POST",
      headers: { Authorization: `Basic ${dfsAuth(credential)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    }, { provider: "dataforseo" }));
  } catch (e: any) {
    return { total: 0, items: [], error: `сеть DataForSEO: ${e?.cause?.code || e?.cause?.message || e?.message || "fetch failed"}` };
  }
  if (!res.ok) {
    const error = `dataforseo ${res.status}: ${(await res.text()).slice(0, 200)}`;
    call.finish({ error });
    return { total: 0, items: [], error };
  }
  const data = await res.json();
  // DataForSEO states what the request cost, in dollars, in the envelope. Read, never computed,
  // and read before the status checks: a task that failed inside a 200 was still charged for.
  const costUsd = Number.isFinite(Number(data?.cost)) ? Number(data.cost) : null;
  if (data?.status_code && data.status_code !== 20000) {
    const error = `dataforseo ${data.status_code}: ${data.status_message}`;
    call.finish({ error, costUsd });
    return { total: 0, items: [], error };
  }
  const taskObj = data?.tasks?.[0];
  if (taskObj?.status_code && taskObj.status_code !== 20000) {
    const error = `dataforseo task ${taskObj.status_code}: ${taskObj.status_message}`;
    call.finish({ error, costUsd });
    return { total: 0, items: [], error };
  }
  call.finish({ costUsd });

  const result = taskObj?.result?.[0] ?? {};
  const total: number = result.total_count ?? (result.items?.length ?? 0);
  const items: Citation[] = (result.items ?? []).map((it: any) => {
    const ci = it.content_info ?? {};
    const ct = ci.connotation_types ?? {};
    const sc = ci.sentiment_connotations ?? {};
    const emotions = Object.fromEntries(EMOTIONS.map(e => [e, Number(sc[e] ?? 0)])) as Record<Emotion, number>;
    const polarity = (maxKey(ct, ["positive", "neutral", "negative"] as const) ?? "neutral") as Polarity;
    return {
      url: it.url ?? "",
      domain: it.domain ?? it.main_domain ?? "",
      title: ci.main_title || ci.title || it.url || "",
      snippet: ci.snippet || ci.highlighted_text || "",
      polarity,
      emotions,
      topEmotion: maxKey(sc, EMOTIONS),
      date: (ci.date_published || ci.group_date || it.fetch_time || "").slice(0, 10),
      score: Number(it.score ?? 0),
    };
  }).filter((c: Citation) => c.url);

  return { total, items };
}
