import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// GET /api/dr?domains=a.com,b.com — Ahrefs Domain Rating via the free public endpoint
// (no API key required). Cached in SQLite for 7 days so the dashboard doesn't hammer
// Ahrefs on every load. License: https://ahrefs.com/legal/domain-rating-license — the UI
// must show "Domain Rating by Ahrefs" attribution wherever DR is displayed.

const TTL_MS = 7 * 24 * 3600 * 1000;

async function fetchDr(domain: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, {
      headers: { Accept: "application/json" },
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
  const missing = cacheOnly ? [] : domains.filter(d => !fresh.has(d)).slice(0, 60); // bounded per request
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < missing.length) {
      const d = missing[i++];
      const dr = await fetchDr(d);
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

  return NextResponse.json({ ratings: out, attribution: "Domain Rating by Ahrefs — https://ahrefs.com/" });
}
