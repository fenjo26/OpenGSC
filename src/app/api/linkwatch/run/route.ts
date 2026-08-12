import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawQuery, rawExec } from "@/lib/db/raw";

// POST /api/linkwatch/run { ahrefsKey, months?, minDr?, limit? }
// For every watched brand, pull fresh quality backlinks via Ahrefs API v3 and store them.
// Filters follow detailed.com/ai-backlinks-api: in-content, DR≥50, new in last 3 months,
// live links, one per domain. Field selection is trimmed to keep unit costs low (~13/row).

const rid = () => "lm" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// The host is a variable, not a literal, for one reason: the Ahrefs API v3 protocol is spoken by
// gateways other than api.ahrefs.com, and a user with such a key had to keep a second, official
// key just for this one feature. The path and the filter syntax are identical either way, which
// also makes this the cheapest place to verify that a gateway really is wire-compatible — it
// exercises `select`, `where` and pagination on code that already works against the real API.
const AHREFS_DEFAULT_BASE = "https://api.ahrefs.com";

async function fetchBrandLinks(ahrefsKey: string, baseUrl: string, brand: string, sinceIso: string, minDr: number, limit: number): Promise<{ rows?: any[]; error?: string }> {
  const params = new URLSearchParams({
    target: brand,
    mode: "subdomains",
    limit: String(limit),
    history: "live",
    aggregation: "1_per_domain",
    order_by: "first_seen_link:desc",
    select: "url_from,title,anchor,domain_rating_source,first_seen_link,url_to,is_dofollow",
    // Official v3 filter syntax (docs.ahrefs.com/en/api/docs/filter-syntax): operators are
    // strings — ["gte", 50], ["eq", true]. Mirrors the detailed.com filter set: in-content,
    // DR ≥ minDr, first seen within the window; live-only comes from history=live.
    where: JSON.stringify({
      and: [
        { field: "is_content", is: ["eq", true] },
        { field: "domain_rating_source", is: ["gte", minDr] },
        { field: "first_seen_link", is: ["gte", sinceIso] },
      ],
    }),
  });
  try {
    const base = (baseUrl || AHREFS_DEFAULT_BASE).replace(/\/+$/, "");
    const res = await fetch(`${base}/v3/site-explorer/all-backlinks?${params}`, {
      headers: { Authorization: `Bearer ${ahrefsKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { error: `ahrefs ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const d = await res.json();
    return { rows: Array.isArray(d?.backlinks) ? d.backlinks : [] };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const ahrefsKey = String(b.ahrefsKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim();
  if (!ahrefsKey) return NextResponse.json({ error: "no_ahrefs_key" }, { status: 400 });
  const months = Math.max(1, Math.min(12, Number(b.months ?? 3)));
  const minDr = Math.max(0, Math.min(90, Number(b.minDr ?? 50)));
  const limit = Math.max(10, Math.min(100, Number(b.limit ?? 50)));
  const since = new Date(Date.now() - months * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let brands: any[] = [];
  try { brands = await rawQuery(`SELECT domain FROM "LinkWatchBrand" WHERE userId = ?`, userId); }
  catch { return NextResponse.json({ error: "not_migrated" }, { status: 500 }); }
  if (!brands.length) return NextResponse.json({ error: "no_brands" }, { status: 400 });

  const errors: Record<string, string> = {};
  let saved = 0;
  // Sequential: Ahrefs rate limits are per-minute; this endpoint runs as a user action.
  for (const { domain: brand } of brands.slice(0, 200)) {
    const r = await fetchBrandLinks(ahrefsKey, baseUrl, brand, since, minDr, limit);
    if (r.error) { errors[brand] = r.error; continue; }
    try {
      await rawExec(`DELETE FROM "LinkMention" WHERE userId = ? AND brand = ?`, userId, brand);
      for (const row of r.rows || []) {
        const urlFrom = String(row.url_from ?? "");
        if (!urlFrom) continue;
        await rawExec(
          `INSERT INTO "LinkMention" (id, userId, brand, urlFrom, domainFrom, title, anchor, drFrom, firstSeen, urlTo, dofollow, fetchedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rid(), userId, brand, urlFrom, domainOf(urlFrom),
          String(row.title ?? ""), String(row.anchor ?? ""), Number(row.domain_rating_source ?? 0),
          String(row.first_seen_link ?? "").slice(0, 10), String(row.url_to ?? ""),
          row.is_dofollow === false ? 0 : 1, new Date().toISOString());
        saved++;
      }
    } catch (e: any) { errors[brand] = String(e?.message ?? e); }
  }
  return NextResponse.json({ ok: true, saved, brandsChecked: brands.length, errors });
}
