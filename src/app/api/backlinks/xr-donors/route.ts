import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { loggedFetch } from "@/lib/providerLog/log";
import { backlinksNotMigrated } from "@/lib/backlinks/store";

// POST — XML River index check for PURCHASED donor pages (меджики loop), across every site of
// the workspace. Ported from the legacy /api/backlinks/check-xr (which still serves the old
// Backlink table) onto SiteBacklink: the bought placements are the ones whose index status
// pays for itself — a donor out of the index is a link nobody will ever see.
//
// Selection: purchased rows whose xrStatus was never checked or went stale (> 14 days — index
// verdicts rot). Capped at 100 per call: XML River is a paid, per-URL balance, and the cap is
// the operator's brake, not a product limit. Capability "spend", same as the legacy route.

const XR_STALE_DAYS = 14;
const PER_CALL_CAP = 100;

export async function POST() {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xmlRiverUserId: true, xmlRiverApiKey: true },
  });
  if (!user?.xmlRiverUserId || !user?.xmlRiverApiKey) {
    return NextResponse.json({ error: "XML River not configured" }, { status: 400 });
  }

  const staleBefore = new Date(Date.now() - XR_STALE_DAYS * 86_400_000);
  let donors: Array<{ id: string; urlFrom: string; siteId: string }>;
  try {
    donors = await prisma.siteBacklink.findMany({
      where: {
        purchaseProvider: { not: "" },
        site: { userId },
        OR: [{ xrStatus: "" }, { xrCheckedAt: null }, { xrCheckedAt: { lt: staleBefore } }],
      },
      select: { id: true, urlFrom: true, siteId: true },
      orderBy: { addedAt: "asc" },
      take: PER_CALL_CAP,
    });
  } catch (e) {
    if (backlinksNotMigrated(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    throw e;
  }
  if (donors.length === 0) return NextResponse.json({ ok: true, checked: 0, indexed: 0, notIndexed: 0, error: 0 });

  // Only the xr* group — CONTRACT.md §1: the index verdict is this writer's field and nobody else's.
  let checked = 0, indexed = 0, notIndexed = 0, errors = 0;
  for (const d of donors) {
    try {
      const apiUrl = `https://xmlriver.com/search_console/json/?user=${encodeURIComponent(user.xmlRiverUserId)}&key=${encodeURIComponent(user.xmlRiverApiKey)}&url=${encodeURIComponent(d.urlFrom)}`;
      const { res, call } = await loggedFetch(apiUrl, { signal: AbortSignal.timeout(8000) }, { provider: "xmlriver" });
      const data = await res.json().catch(() => ({}));
      call.finish(data?.error ? { error: String(data.error).slice(0, 300), responseBody: data } : { responseBody: data });
      const xrStatus = data?.error ? "error" : data?.indexed ? "indexed" : "not_indexed";
      await prisma.siteBacklink.update({
        where: { id: d.id },
        data: { xrStatus, xrCheckedAt: new Date() },
      }).catch(() => { /* row deleted mid-run — the verdict dies with it */ });
      checked++;
      if (xrStatus === "indexed") indexed++;
      else if (xrStatus === "not_indexed") notIndexed++;
      else errors++;
      await new Promise(r => setTimeout(r, 300)); // same politeness as the legacy route
    } catch {
      errors++;
    }
  }

  return NextResponse.json({ ok: true, checked, indexed, notIndexed, error: errors });
}
