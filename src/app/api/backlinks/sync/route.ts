import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { estimateCostUsd, MetricsCreds, fetchKeyssoBacklinksPage, KEYSSO_BACKLINK_PAGE_SIZE } from "@/lib/seo/metrics";
import { recordUsage, releaseUnusedUnits, withinCap } from "@/lib/seo/metricsStore";
import { normDomain } from "@/lib/seo/backlinkStore";
import { resolveDataforseoCreds, startDataforseoExport } from "@/lib/seo/dataforseoBacklinks";
import {
  EXPORT_PAGE_SIZE, PROBE_UNITS, STATS_UNITS,
  cachedPaginationMode, estimateExportUnits, fetchBacklinksStats,
} from "@/lib/seo/backlinksApi";
import {
  createApiSync, listApiSyncs, runBacklinkExport, runKeyssoBacklinkExport, runningApiSync,
} from "@/lib/seo/siteBacklinkStore";

// Full backlink export from Ahrefs — the api writer of the backlinks v2 wave.
// POST /api/backlinks/sync { siteId, provider?, confirm?, apiKey?, baseUrl?, cap? }
//   provider "keysso" → the same export from Keys.so's Runet index (1 credit per 100 links);
//   provider "dataforseo" → the same export from DataForSEO, live and lost links
//                           ($0.024 per 1 000-link page + $0.000036 per link);
//   anything else → Ahrefs, as before.
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

  if (b.provider === "keysso") return keyssoSync(userId, siteId, target, b, confirm, cap);
  if (b.provider === "dataforseo") {
    const creds = await resolveDataforseoCreds(userId, b);
    if (!creds) return NextResponse.json({ error: "no_key" }, { status: 400 });
    const r = await startDataforseoExport({ userId, siteId, target, creds, cap, confirm });
    return NextResponse.json(r.body, { status: r.status });
  }

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

/**
 * The Keys.so export: priced from a one-credit `per_page=1` read whose envelope `total` is the
 * live backlink count, then the same confirm gate, the same one-run-per-site rule, and the same
 * detached runner pattern as the Ahrefs path — only the wallet (`keysso`) and the pager differ.
 */
async function keyssoSync(
  userId: string, siteId: string, target: string,
  b: { apiKey?: unknown; baseUrl?: unknown }, confirm: boolean, cap: number,
) {
  const creds = await resolveKeyssoCreds(userId, b);
  if (!creds) return NextResponse.json({ error: "no_key" }, { status: 400 });

  if (!(await withinCap(userId, "keysso", 1, cap))) {
    return NextResponse.json({ error: "cap_exceeded", wouldSpend: 1 }, { status: 429 });
  }
  await recordUsage(userId, "keysso", 1);
  const stats = await fetchKeyssoBacklinksPage(creds, target, 1, 1);
  if (stats.error || stats.total == null) {
    // A refused read is not billed by the gateway — it comes back off the month.
    await releaseUnusedUnits(userId, "keysso", 1, stats.units);
    return NextResponse.json({ error: stats.error ?? "stats_failed" }, { status: 502 });
  }
  const live = stats.total;
  const pages = Math.max(1, Math.ceil(live / KEYSSO_BACKLINK_PAGE_SIZE));
  const estimate = { rows: live, pages, units: pages, usd: estimateCostUsd(pages, "keysso"), provider: "keysso" };
  if (!confirm) return NextResponse.json({ confirmRequired: true, estimate });

  const running = await runningApiSync(siteId);
  if (running) return NextResponse.json({ error: "already_running", id: running.id }, { status: 409 });
  if (!(await withinCap(userId, "keysso", pages, cap))) {
    return NextResponse.json({ error: "cap_exceeded", wouldSpend: pages }, { status: 429 });
  }
  await recordUsage(userId, "keysso", pages);
  const sync = await createApiSync(siteId, "keysso_page");
  runKeyssoBacklinkExport({ syncId: sync.id, siteId, userId, target, creds, live, reservedUnits: pages })
    .catch(err => console.error(`[backlinks-sync:keysso] ${sync.id} failed:`, err));
  return NextResponse.json({ id: sync.id, estimate });
}

/** Keys.so key from the body, else the seoSettings mirror — same slot/mode chain as Ahrefs above. */
async function resolveKeyssoCreds(userId: string, body: { apiKey?: unknown; baseUrl?: unknown }): Promise<MetricsCreds | null> {
  const apiKey = String(body.apiKey ?? "").trim();
  if (apiKey) return { provider: "keysso", apiKey, baseUrl: String(body.baseUrl ?? "").trim() || undefined };
  try {
    const rows: { seoSettings: string | null }[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = JSON.parse(rows?.[0]?.seoSettings ?? "{}") as Record<string, unknown>;
    const mode = String(s.seoMetricsMode_keysso ?? "");
    const slot = mode === "reseller" || mode === "custom" ? "seoKey_keysso__" + mode : "seoKey_keysso";
    const key = String(s[slot] ?? s.seoKey_keysso ?? "").trim();
    return key ? { provider: "keysso", apiKey: key, baseUrl: String(s.seoMetricsBaseUrl_keysso ?? "").trim() || undefined } : null;
  } catch { return null; }
}
