import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { rawQuery, rawExec, currentDialect } from "@/lib/db/raw";

// Link Monitor brands + aggregated report (detailed.com/ai-backlinks-api workflow).
// GET    /api/linkwatch                → { brands, mentions, topDomains }
// POST   /api/linkwatch { domains[] }  → add watched brands
// DELETE /api/linkwatch?domain=x.com   → remove a brand (and its mentions)

const norm = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const rid = () => "lw" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const brands: any[] = await rawQuery(`SELECT id, domain, createdAt FROM "LinkWatchBrand" WHERE userId = ? ORDER BY domain`, userId);
    const mentions: any[] = await rawQuery(
      `SELECT brand, urlFrom, domainFrom, title, anchor, drFrom, firstSeen, dofollow, fetchedAt
       FROM "LinkMention" WHERE userId = ? ORDER BY firstSeen DESC LIMIT 1000`, userId);
    const topDomains: any[] = await rawQuery(
      `SELECT domainFrom, COUNT(DISTINCT brand) as brandsLinked, COUNT(*) as links, MAX(drFrom) as maxDr
       FROM "LinkMention" WHERE userId = ? GROUP BY domainFrom ORDER BY brandsLinked DESC, links DESC LIMIT 100`, userId);
    return NextResponse.json({ brands, mentions, topDomains });
  } catch {
    return NextResponse.json({ brands: [], mentions: [], topDomains: [], notMigrated: true });
  }
}

export async function POST(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const domains: string[] = ([...new Set((Array.isArray(b.domains) ? b.domains : []).map((d: any) => norm(String(d))).filter((d: string) => d.includes(".")))] as string[]).slice(0, 200);
  if (!domains.length) return NextResponse.json({ error: "no_domains" }, { status: 400 });
  let added = 0;
  // `INSERT OR IGNORE` is SQLite's "skip the duplicate" spelling; MySQL writes it `INSERT IGNORE`.
  // The rest of the codebase routes conflict-skips through runUpsert, but this insert carries a
  // generated id and wants to do nothing on conflict, which is exactly what both spellings mean.
  // portableSql rewrites the double-quoted table name to backticks on MySQL; the OR IGNORE / IGNORE
  // keyword is chosen here because it sits outside any quoted identifier.
  const ignore = currentDialect() === "mysql" ? "IGNORE" : "OR IGNORE";
  for (const d of domains) {
    try {
      await rawExec(
        `INSERT ${ignore} INTO "LinkWatchBrand" (id, userId, domain, createdAt) VALUES (?, ?, ?, ?)`,
        rid(), userId, d, new Date().toISOString());
      added++;
    } catch { /* skip */ }
  }
  return NextResponse.json({ ok: true, added });
}

export async function DELETE(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const domain = norm(String(searchParams.get("domain") ?? ""));
  if (!domain) return NextResponse.json({ error: "no_domain" }, { status: 400 });
  try {
    await rawExec(`DELETE FROM "LinkWatchBrand" WHERE userId = ? AND domain = ?`, userId, domain);
    await rawExec(`DELETE FROM "LinkMention" WHERE userId = ? AND brand = ?`, userId, domain);
  } catch { /* table missing */ }
  return NextResponse.json({ ok: true });
}
