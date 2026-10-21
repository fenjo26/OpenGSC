import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { makePbnFetch, prescanDomain } from "@/lib/pbn/restore";

export const dynamic = "force-dynamic";

/** POST { domains: string[] } — снимки со score для каждого домена. Бесплатно (net, через прокси). */
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const domains = (Array.isArray(body?.domains) ? body.domains : [])
    .filter((d: unknown): d is string => typeof d === "string").map(d => d.trim().toLowerCase()).filter(Boolean).slice(0, 25);
  if (!domains.length) return NextResponse.json({ error: "no_domains" }, { status: 400 });
  const fetch = await makePbnFetch(userId);
  const results: unknown[] = [];
  for (const domain of domains) {
    try {
      const { snapshots, best } = await prescanDomain(domain, fetch);
      results.push({ domain, snapshots, best });
    } catch {
      results.push({ domain, error: "prescan_failed" });
    }
  }
  return NextResponse.json({ results });
}
