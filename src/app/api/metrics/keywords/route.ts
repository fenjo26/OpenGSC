import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  fetchKeywordMetrics, estimateKeywordUnits, MetricsProvider,
} from "@/lib/seo/metrics";
import {
  readKeywordCache, writeKeywordCache, staleKeywords, readUsage, recordUsage, withinCap,
  normalizeKeyword,
} from "@/lib/seo/metricsStore";

// POST /api/metrics/keywords
//   { keywords: string[], country?, withDifficulty?, provider?, apiKey?, baseUrl?, cap?, fetch? }
//
// Cache-first, and paid only when explicitly asked. Two call shapes:
//
//   fetch: false (default) — read the cache and return what is there. Free, always safe to call
//     on render. This is how a page shows weights it already has, including ones that arrived
//     via CSV import with no API key involved at all.
//
//   fetch: true — the user pressed "load weights". Missing/stale keywords are priced, checked
//     against the monthly cap, charged, and fetched. Without a key this degrades to the first
//     shape rather than erroring: no key is a normal state, not a failure.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const keywords: string[] = Array.isArray(b.keywords)
    ? [...new Set<string>(b.keywords.map((k: any) => normalizeKeyword(String(k))))].filter(Boolean)
    : [];
  if (!keywords.length) return NextResponse.json({ metrics: {}, units: 0 });

  const country = String(b.country ?? "us").toLowerCase();
  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const withDifficulty = !!b.withDifficulty;
  const wantFetch = !!b.fetch;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);

  const cache = await readKeywordCache(keywords, country, provider);
  const usage = await readUsage(userId, provider);

  // Read-only path: no fetch requested, or nothing to fetch with.
  if (!wantFetch || !apiKey) {
    return NextResponse.json({
      metrics: cache,
      units: 0,
      usage,
      fetched: 0,
      ...(wantFetch && !apiKey ? { error: "no_key" } : {}),
    });
  }

  // Only unknown or expired keywords are worth money. A run where everything is cached costs
  // nothing and must not send a request at all — the 50-unit floor means even a one-row
  // "just to be safe" call is a real charge.
  const stale = staleKeywords(keywords, cache, { needDifficulty: withDifficulty });
  if (!stale.length) {
    return NextResponse.json({ metrics: cache, units: 0, usage, fetched: 0, fromCache: true });
  }

  const units = estimateKeywordUnits(stale.length, withDifficulty);
  if (!(await withinCap(userId, provider, units, cap))) {
    return NextResponse.json({
      metrics: cache, units: 0, usage, fetched: 0,
      error: "cap_exceeded", wouldSpend: units,
    }, { status: 429 });
  }

  // Charged before the call: the price is fully known from `select` and row count, and a cap
  // that only notices an overspend afterwards is not a cap.
  await recordUsage(userId, provider, units);

  const res = await fetchKeywordMetrics(
    { provider, apiKey, baseUrl },
    stale,
    { country, withDifficulty },
  );

  if (res.error) {
    return NextResponse.json({
      metrics: cache, units, usage: await readUsage(userId, provider), fetched: 0, error: res.error,
    }, { status: 502 });
  }

  await writeKeywordCache(res.items, country, provider, "api");
  const merged = await readKeywordCache(keywords, country, provider);

  return NextResponse.json({
    metrics: merged,
    units,
    usage: await readUsage(userId, provider),
    fetched: res.items.length,
    requested: stale.length,
  });
}
