import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchDomainMetrics, DOMAIN_UNITS, MetricsProvider } from "@/lib/seo/metrics";
import {
  readDomainCache, writeDomainCache, readUsage, recordUsage, withinCap, DOMAIN_TTL_DAYS,
} from "@/lib/seo/metricsStore";

// POST /api/metrics/domain  { domains: string[], provider?, apiKey?, baseUrl?, cap?, fetch? }
//
// The paid companion to `/api/dr`, and deliberately a separate endpoint rather than an extension
// of it. `/api/dr` serves Domain Rating from the free public endpoint with no key, for everyone,
// and must keep working exactly as it does — including when this route is unconfigured, out of
// credits, or failing. Nothing here is allowed to become a dependency of that.
//
// Default shape is a free cache read, so a dashboard can call it on render. Fetching is opt-in
// and costs 100 units per domain (two floored calls), which is why nothing does it automatically.

const norm = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const domains: string[] = Array.isArray(b.domains)
    ? [...new Set<string>(b.domains.map((d: any) => norm(String(d))))].filter(d => d.includes("."))
    : [];
  if (!domains.length) return NextResponse.json({ metrics: {}, units: 0 });

  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const wantFetch = !!b.fetch;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);

  const cache = await readDomainCache(domains, provider);
  const usage = await readUsage(userId, provider);

  if (!wantFetch || !apiKey) {
    return NextResponse.json({
      metrics: cache, units: 0, usage, fetched: 0,
      ...(wantFetch && !apiKey ? { error: "no_key" } : {}),
    });
  }

  const ttl = DOMAIN_TTL_DAYS * 24 * 3600 * 1000;
  const stale = domains.filter(d => {
    const hit = cache[d];
    return !hit || Date.now() - new Date(hit.checkedAt).getTime() > ttl;
  });
  if (!stale.length) {
    return NextResponse.json({ metrics: cache, units: 0, usage, fetched: 0, fromCache: true });
  }

  const units = DOMAIN_UNITS * stale.length;
  if (!(await withinCap(userId, provider, units, cap))) {
    return NextResponse.json({
      metrics: cache, units: 0, usage, fetched: 0, error: "cap_exceeded", wouldSpend: units,
    }, { status: 429 });
  }
  await recordUsage(userId, provider, units);

  // Sequential rather than Promise.all: each domain already issues two requests, and the
  // provider allows three in flight per key. The module-level pool would queue a fan-out
  // anyway, so doing it here keeps the failure ordering readable.
  let fetched = 0;
  let lastError = "";
  for (const domain of stale) {
    const res = await fetchDomainMetrics({ provider, apiKey, baseUrl }, domain);
    if (res.error) { lastError = res.error; continue; }
    await writeDomainCache(res.items, provider, "api");
    fetched++;
  }

  return NextResponse.json({
    metrics: await readDomainCache(domains, provider),
    units,
    usage: await readUsage(userId, provider),
    fetched,
    requested: stale.length,
    ...(fetched === 0 && lastError ? { error: lastError } : {}),
  });
}
