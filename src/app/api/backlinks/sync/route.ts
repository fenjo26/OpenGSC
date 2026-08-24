import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { estimateCostUsd, MetricsCreds } from "@/lib/seo/metrics";
import { recordUsage, withinCap } from "@/lib/seo/metricsStore";
import { normDomain } from "@/lib/seo/backlinkStore";
import {
  EXPORT_PAGE_SIZE, PROBE_UNITS, STATS_UNITS,
  cachedPaginationMode, estimateExportUnits, fetchBacklinksStats,
} from "@/lib/seo/backlinksApi";
import {
  createApiSync, listApiSyncs, runBacklinkExport, runningApiSync,
} from "@/lib/seo/siteBacklinkStore";

// Full backlink export from Ahrefs — the api writer of the backlinks v2 wave.
// POST /api/backlinks/sync { siteId, confirm?, apiKey?, baseUrl?, cap? }
//   without confirm → { confirmRequired: true, estimate } — the price, nothing spent beyond the
//                     one stats call that priced it
//   with confirm    → creates a SiteBacklinkSync row, runs the export fire-and-forget
//                     (the /api/audit pattern), returns { id, estimate }
// GET  /api/backlinks/sync?siteId= → the current and recent runs, latest first.
//
// The estimate is the gate: this operation spends the owner's units by the hundred-thousand on a
// large profile, so it never starts until the caller has seen "≈ N links, ≈ M units, ≈ $X" and
// sent it back as confirm: true. There is no row ceiling to hide behind — the TЗ forbids one —
// only a price the user confirms.

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const confirm = b.confirm === true;
  const cap = Number(b.cap ?? 0);

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The target comes from the site row, never from the body — same reason as
  // /api/metrics/backlinks: an endpoint that spends the owner's credits must not profile
  // arbitrary domains just because someone asked it to.
  const target = normDomain(String(site.url ?? "").replace(/^sc-domain:/, ""));
  if (!target) return NextResponse.json({ error: "bad_site_url" }, { status: 400 });

  const resolved = await resolveAhrefsCreds(userId, b);
  if (resolved === "semrush") return NextResponse.json({ error: "provider_unsupported" }, { status: 400 });
  if (!resolved) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const creds = resolved;

  // One paid call (50 units) to know the profile size the price is quoted from. It is recorded
  // even on the estimate-only path — the gateway bills it either way, and a balance that omits
  // it would lie to the next screen.
  if (!(await withinCap(userId, "ahrefs", STATS_UNITS, cap))) {
    return NextResponse.json({ error: "cap_exceeded", wouldSpend: STATS_UNITS }, { status: 429 });
  }
  await recordUsage(userId, "ahrefs", STATS_UNITS);
  const stats = await fetchBacklinksStats(creds, target);
  if (stats.error || stats.live == null) {
    return NextResponse.json({ error: stats.error ?? "stats_failed" }, { status: 502 });
  }
  const live = stats.live;

  const mode = cachedPaginationMode(creds);
  const units = (mode ? 0 : PROBE_UNITS) + estimateExportUnits(live);
  const estimate = {
    rows: live,
    pages: Math.max(1, Math.ceil(live / EXPORT_PAGE_SIZE)),
    units,
    usd: estimateCostUsd(units, "ahrefs"),
    paginationMode: mode,
  };

  if (!confirm) {
    return NextResponse.json({ confirmRequired: true, estimate });
  }

  // One live run per site. A second attempt while the first is alive is a 409; a run whose
  // heartbeat died with the process is marked failed where runningApiSync looks, not silently
  // restarted — a restart would re-spend units on a price the user never confirmed twice.
  const running = await runningApiSync(siteId);
  if (running) return NextResponse.json({ error: "already_running", id: running.id }, { status: 409 });

  if (!(await withinCap(userId, "ahrefs", units, cap))) {
    return NextResponse.json({ error: "cap_exceeded", wouldSpend: units }, { status: 429 });
  }
  // Reserve the ceiling up front, reconcile in the runner's finally: failed pages bill nothing,
  // and the runner refunds the difference once the true count is known.
  await recordUsage(userId, "ahrefs", units);

  const sync = await createApiSync(siteId, mode ?? "");
  runBacklinkExport({
    syncId: sync.id, siteId, userId, target, creds,
    live, reservedUnits: units, mode,
  }).catch(err => console.error(`[backlinks-sync] ${sync.id} failed:`, err));

  return NextResponse.json({ id: sync.id, estimate });
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  // Owner session — or a valid share token for this exact site, read-only (same guest shape
  // as /api/audit). Guests never reach POST: this screen spends the owner's units.
  const shareToken = searchParams.get("shareToken") ?? "";
  const site = userId
    ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } })
    : shareToken
      ? await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true }, select: { id: true } })
      : null;
  if (!site) return NextResponse.json({ error: userId ? "Not found" : "Unauthorized" }, { status: userId ? 404 : 401 });

  return NextResponse.json({ runs: await listApiSyncs(siteId, 10) });
}

/**
 * Credentials for the export: explicit body key first (the browser sends its localStorage pair,
 * like every /api/metrics route), otherwise the User.seoSettings mirror — the same key names and
 * mode fallback chain the warmup scheduler uses, because this is background work and must resolve
 * server-side after the request that started it is gone.
 *
 * Returns null when no Ahrefs key exists anywhere, "semrush" when the mirrored provider is
 * Semrush with no separate Ahrefs key — the export is Ahrefs-only, same stance as
 * fetchBacklinkProfile, and deserves its own error rather than a bare "no key".
 */
async function resolveAhrefsCreds(
  userId: string, body: { apiKey?: unknown; baseUrl?: unknown },
): Promise<MetricsCreds | "semrush" | null> {
  const apiKey = String(body.apiKey ?? "").trim();
  if (apiKey) {
    return { provider: "ahrefs", apiKey, baseUrl: String(body.baseUrl ?? "").trim() || undefined };
  }
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = JSON.parse(rows?.[0]?.seoSettings ?? "{}") as Record<string, any>;
    const mode = String(s.seoMetricsMode_ahrefs ?? "");
    const slot = mode === "reseller" || mode === "custom"
      ? "seoKey_ahrefs__" + mode
      : "seoKey_ahrefs";
    const key = String(s[slot] ?? s.seoKey_ahrefs ?? "").trim();
    if (key) {
      return { provider: "ahrefs", apiKey: key, baseUrl: String(s.seoMetricsBaseUrl_ahrefs ?? "").trim() || undefined };
    }
    return s.seoMetricsProvider === "semrush" ? "semrush" : null;
  } catch { return null; }
}
