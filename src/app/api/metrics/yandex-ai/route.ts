import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { fetchYandexAiReport, KEYSSO_AI_UNITS, type YandexAiReport } from "@/lib/seo/metrics";
import {
  readDomainCache, writeDomainCache, readUsage, recordUsage, releaseUnusedUnits, withinCap,
} from "@/lib/seo/metricsStore";
import { normDomain } from "@/lib/seo/backlinkStore";

// POST /api/metrics/yandex-ai { siteId, fetch?, apiKey?, baseUrl?, cap? }
//
// Yandex AI-answer visibility from Keys.so, with the same two-shape contract as every metrics
// route: a free read of the stored report, and an opt-in paid refresh (2 credits).
//
// Storage reuses DomainMetricCache under the pseudo-provider `keysso_ai` — one row per domain,
// the report in `payload` — so this ships without a schema change. Nothing that reads the
// cache by a real provider name can see these rows (`parseMetricsProvider` never yields it).
// Usage is metered on `keysso`, the wallet the credits actually come from.

const CACHE_PROVIDER = "keysso_ai";

function parseReport(payload: unknown): YandexAiReport | null {
  if (!payload) return null;
  try {
    const r = typeof payload === "string" ? JSON.parse(payload) : payload;
    return r && Array.isArray(r.answers) ? (r as YandexAiReport) : null;
  } catch { return null; }
}

async function readReport(domain: string): Promise<YandexAiReport | null> {
  const cache = await readDomainCache([domain], CACHE_PROVIDER);
  return parseReport((cache[domain] as unknown as { payload?: unknown } | undefined)?.payload);
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const wantFetch = !!b.fetch;
  const userId = await workspaceUserId(wantFetch ? "spend" : undefined);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The target comes from a site the caller owns — never from a free-form field, or the route
  // would spend the owner's credits on any domain on the internet.
  const site = await prisma.site.findFirst({ where: { id: String(b.siteId ?? ""), userId }, select: { url: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  const domain = normDomain(site.url.replace(/^sc-domain:/, ""));

  const stored = await readReport(domain);
  const apiKey = String(b.apiKey ?? "").trim();
  if (!wantFetch) return NextResponse.json({ domain, report: stored, usage: await readUsage(userId, "keysso") });
  if (!apiKey) return NextResponse.json({ domain, report: stored, error: "no_key" });

  const cap = Number(b.cap ?? 0) || 0;
  if (!(await withinCap(userId, "keysso", KEYSSO_AI_UNITS, cap))) {
    return NextResponse.json({ domain, report: stored, error: "cap_exceeded" }, { status: 429 });
  }
  await recordUsage(userId, "keysso", KEYSSO_AI_UNITS);
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const res = await fetchYandexAiReport({ provider: "keysso", apiKey, baseUrl }, domain);
  // Refused reads are not billed by the gateway, so they come back off the month.
  await releaseUnusedUnits(userId, "keysso", KEYSSO_AI_UNITS, res.units);

  if (!res.ok) {
    return NextResponse.json({ domain, report: stored, error: res.error, usage: await readUsage(userId, "keysso") }, { status: 502 });
  }
  await writeDomainCache([{ domain, payload: res.report }], CACHE_PROVIDER, "api");
  return NextResponse.json({ domain, report: res.report, units: res.units, usage: await readUsage(userId, "keysso") });
}
