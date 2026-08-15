import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import { goanyDr } from "@/lib/seo/goanyapi";

// GET /api/dr?domains=a.com,b.com — Ahrefs Domain Rating via the free public endpoint.
// Cached in SQLite for 7 days so the dashboard doesn't hammer Ahrefs on every load. License:
// https://ahrefs.com/legal/domain-rating-license — the UI must show "Domain Rating by Ahrefs"
// attribution wherever DR is displayed.
//
// Ahrefs used to serve this endpoint with no key at all; they since started requiring an APIv3
// key on it too (still free to generate, no paid subscription needed — see Settings → SEO
// Metrics). The client sends its own key via the `x-ahrefs-dr-key` header, since keys in this
// app live in the browser's localStorage, not server-side. Cached rows still serve fine with no
// key configured — only fetching a *new* rating requires one.

const TTL_MS = 7 * 24 * 3600 * 1000;

async function fetchDr(domain: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const dr = Number(d?.domain_rating?.domain_rating ?? d?.domain_rating ?? d?.dr);
    return isFinite(dr) ? dr : null;
  } catch { return null; }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const shareToken = searchParams.get('shareToken');
  let isAuthorized = !!(await workspaceUserId());
  if (!isAuthorized && shareToken) {
    const site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true } });
    if (site) isAuthorized = true;
  }
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (req.headers.get("x-ahrefs-dr-key") || "").trim();
  // Fallback source, used only when no Ahrefs key exists. GoAnyAPI resells the same figure — its
  // response literally returns `domain_rating` and `ahrefs_rank` — but charges 2 credits for what
  // Ahrefs gives away free, so it must never win while the free path is available. One domain per
  // call there, hence the tighter batch below.
  const goAnyKey = (req.headers.get("x-goanyapi-key") || "").trim();

  const domains = [...new Set(String(searchParams.get("domains") ?? "").split(",")
    .map(s => s.trim().toLowerCase().replace(/^www\./, "")).filter(d => d && d.includes(".")))].slice(0, 250);
  if (!domains.length) return NextResponse.json({ ratings: {} });

  const out: Record<string, { dr: number; checkedAt: string }> = {};
  let cached: any[] = [];
  try {
    cached = await rawQuery(
      `SELECT domain, dr, checkedAt FROM "DrCache" WHERE domain IN (${domains.map(() => "?").join(",")})`, ...domains);
  } catch { /* table missing until prisma db push */ }
  const fresh = new Set<string>();
  for (const r of cached) {
    const age = Date.now() - new Date(r.checkedAt).getTime();
    if (age < TTL_MS) { out[r.domain] = { dr: Number(r.dr), checkedAt: r.checkedAt }; fresh.add(r.domain); }
  }

  const cacheOnly = searchParams.get("cacheOnly") === "1";
  const useGoAny = !apiKey && !!goAnyKey;
  // No key of either kind → nothing new to fetch; cached rows still return above, untouched.
  const haveKey = !!apiKey || useGoAny;
  // GoAnyAPI bills per call and rate-limits at roughly 5/s, so a paid fallback gets a much
  // smaller batch than the free endpoint. Whatever it does not cover this round is still served
  // from cache next time; spending sixty credits to fill a dashboard nobody asked to refresh is
  // not a trade to make on the user's behalf.
  const cap = useGoAny ? 10 : 60;
  const missing = cacheOnly || !haveKey ? [] : domains.filter(d => !fresh.has(d)).slice(0, cap);
  let i = 0;
  await Promise.all(Array.from({ length: useGoAny ? 2 : 4 }, async () => {
    while (i < missing.length) {
      const d = missing[i++];
      const dr = useGoAny ? (await goanyDr(goAnyKey, d)).data?.dr ?? null : await fetchDr(d, apiKey);
      if (dr == null) continue;
      out[d] = { dr, checkedAt: new Date().toISOString() };
      try {
        await runUpsert({
          table: "DrCache",
          conflict: ["domain"],
          values: { domain: d, dr, checkedAt: new Date().toISOString() },
          update: { dr: "set", checkedAt: "set" },
        });
      } catch { /* cache best-effort */ }
    }
  }));

  return NextResponse.json({
    ratings: out,
    // The attribution stands either way: GoAnyAPI's numbers are Ahrefs' numbers, relabelled.
    attribution: "Domain Rating by Ahrefs — https://ahrefs.com/",
    keyConfigured: haveKey,
    source: useGoAny ? "goanyapi" : "ahrefs",
  });
}
