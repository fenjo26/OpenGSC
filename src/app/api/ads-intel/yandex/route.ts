import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import { fetchYandexDirectReport, KEYSSO_DIRECT_UNITS } from "@/lib/seo/metrics";
import { recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";

// POST /api/ads-intel/yandex { domain, fetch?, apiKey?, baseUrl?, cap? }
//
// The Yandex half of the Ads tab: how a domain advertises in Yandex Direct, from Keys.so. Same
// contract as the Google half next door — the cached snapshot reads free, a refresh spends
// (2 Keys.so credits) — and the same cache table (`AdIntelCache`, section `yandex_direct`), so
// a competitor looked up once stays annotated. 7-day TTL: campaigns move weekly, not hourly.
// Metered on `keysso` against the user's Keys.so cap.

const TTL_MS = 7 * 24 * 3600 * 1000;
const SECTION = "yandex_direct";

const normDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const wantFetch = !!b.fetch;
  const userId = await workspaceUserId(wantFetch ? "spend" : "read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const domain = normDomain(String(b.domain ?? ""));
  if (!domain.includes(".")) return NextResponse.json({ error: "bad_domain" }, { status: 400 });

  let cached: { payload: unknown; checkedAt: string; fresh: boolean } | null = null;
  try {
    const rows: { payload: string; checkedAt: string }[] = await rawQuery(
      `SELECT payload, checkedAt FROM "AdIntelCache" WHERE domain = ? AND section = ? AND key = ?`, domain, SECTION, "");
    if (rows?.[0]) {
      cached = {
        payload: JSON.parse(rows[0].payload),
        checkedAt: rows[0].checkedAt,
        fresh: Date.now() - new Date(rows[0].checkedAt).getTime() < TTL_MS,
      };
    }
  } catch { cached = null; }

  if (!wantFetch) return NextResponse.json({ domain, ...(cached ?? { payload: null }) });
  if (cached?.fresh) return NextResponse.json({ domain, ...cached, cached: true });

  const apiKey = String(b.apiKey ?? "").trim();
  if (!apiKey) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const cap = Number(b.cap ?? 0) || 0;
  if (!(await withinCap(userId, "keysso", KEYSSO_DIRECT_UNITS, cap))) {
    return NextResponse.json({ error: "cap_exceeded" }, { status: 429 });
  }
  await recordUsage(userId, "keysso", KEYSSO_DIRECT_UNITS);
  const res = await fetchYandexDirectReport(
    { provider: "keysso", apiKey, baseUrl: String(b.baseUrl ?? "").trim() || undefined }, domain);
  await releaseUnusedUnits(userId, "keysso", KEYSSO_DIRECT_UNITS, res.units);
  if (!res.ok) return NextResponse.json({ domain, error: res.error, ...(cached ?? {}) }, { status: 502 });

  const checkedAt = new Date().toISOString();
  try {
    await runUpsert({
      table: "AdIntelCache",
      conflict: ["domain", "section", "key"],
      values: { domain, section: SECTION, key: "", payload: JSON.stringify(res.report), checkedAt },
      update: { payload: "set", checkedAt: "set" },
    });
  } catch { /* best effort — the answer is paid for and returned either way */ }
  return NextResponse.json({ domain, payload: res.report, checkedAt, units: res.units });
}
