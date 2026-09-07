import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { writeMetricsUpdates, schemaMissing } from "@/lib/drops/store";
import { drForDomains } from "@/lib/drops/drFree";

export const dynamic = "force-dynamic";

/**
 * DR for catalogue rows, resolved server-side.
 *
 * The dashboard's /api/dr takes its key from the browser and goes silent when this browser
 * never entered one; the drops button cannot afford that failure mode, so this route resolves
 * the key from the owner's settings (free DR key, paid Ahrefs key as fallback) and persists the
 * numbers straight onto the candidates. The response carries `keyFound: false` when no key
 * exists anywhere — the UI must say "настроить ключ", not show a silent zero.
 */
const MAX_DOMAINS = 250;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const requested: unknown[] = Array.isArray(body?.domains) ? body.domains : [];
    const domains = requested
      .filter((d): d is string => typeof d === "string")
      .map(d => d.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_DOMAINS);
    if (!domains.length) return NextResponse.json({ updated: 0, ratings: {}, keyFound: false });

    const { ratings, keyFound } = await drForDomains(userId, domains);
    const entries = Object.entries(ratings).map(([domain, dr]) => ({ domain, dr }));
    const updated = entries.length ? await writeMetricsUpdates(userId, entries) : 0;

    return NextResponse.json({ ratings, updated, keyFound, attribution: "Domain Rating by Ahrefs — https://ahrefs.com/" });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
