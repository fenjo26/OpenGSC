import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { verifyAuthOrShare } from "@/lib/authShare";
import { getOwnerEngineKey } from "@/lib/engineKeysServer";

// Yandex.Webmaster API v4 integration (mirrors the Bing route pattern: the user's
// OAuth token lives browser-side and is passed per-request, nothing stored here).
// Token: create an app at https://oauth.yandex.ru (Webmaster permissions), get the
// token via the authorize?response_type=token flow — a plain string like "y0_Ag…".
//
// GET  /api/indexing/yandex?siteUrl=&token=          → summary + popular queries + recrawl quota
// POST /api/indexing/yandex { action, siteUrl, token, sitemapUrl? | urls? }
//        action "sitemap"  → add a sitemap (user-added-sitemaps)
//        action "recrawl"  → send up to 10 URLs for reindexing (recrawl/queue)

const BASE = "https://api.webmaster.yandex.net/v4";

async function yFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `OAuth ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Resolve user_id + the host_id matching the site's domain. Yandex host ids look like
// "https:example.com:443" — match by hostname, prefer verified hosts and https.
async function resolveHost(token: string, siteUrl: string): Promise<{ userId?: number; hostId?: string; error?: string }> {
  const user = await yFetch("/user/", token);
  if (!user.ok) return { error: user.status === 401 ? "invalid_token" : `yandex ${user.status}: ${JSON.stringify(user.body).slice(0, 200)}` };
  const userId = user.body.user_id;

  const hosts = await yFetch(`/user/${userId}/hosts/`, token);
  if (!hosts.ok) return { error: `yandex hosts ${hosts.status}` };
  const wanted = siteUrl.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  const list: any[] = hosts.body.hosts ?? [];
  const matches = list.filter(h => {
    const hn = String(h.ascii_host_url ?? h.unicode_host_url ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[:/].*$/, "").toLowerCase();
    return hn === wanted;
  });
  const best =
    matches.find(h => h.verified && String(h.ascii_host_url).startsWith("https")) ??
    matches.find(h => h.verified) ?? matches[0];
  if (!best) return { userId, error: "host_not_found" };
  if (!best.verified) return { userId, hostId: best.host_id, error: "host_not_verified" };
  return { userId, hostId: best.host_id };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const siteUrl = searchParams.get("siteUrl") || "";
    let token = searchParams.get("token") || "";
    const siteId = searchParams.get("siteId") || "";
    const shareToken = searchParams.get("shareToken") || "";

    // Authenticate as the logged-in owner OR via a valid share link for this site.
        let ownerId = await workspaceUserId();
    if (!ownerId && shareToken && siteId) {
      const auth = await verifyAuthOrShare(req, siteId);
      if (auth) ownerId = auth.userId;
    }
    if (!ownerId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Guests (and owners who didn't pass a token) get it resolved from the owner's saved settings.
    if (!token && siteId) token = await getOwnerEngineKey(ownerId, "yandex", siteId);
    if (!siteUrl || !token) return NextResponse.json({ error: "Missing siteUrl or token" }, { status: 400 });

    const host = await resolveHost(token, siteUrl);
    if (host.error) return NextResponse.json({ error: host.error }, { status: host.error === "invalid_token" ? 401 : 400 });
    const p = `/user/${host.userId}/hosts/${encodeURIComponent(host.hostId!)}`;

    const days = Math.min(180, Math.max(7, parseInt(searchParams.get("days") ?? "28", 10) || 28));
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const [summary, queries, quota, history, diagnostics] = await Promise.all([
      yFetch(`${p}/summary/`, token),
      yFetch(`${p}/search-queries/popular/?order_by=TOTAL_SHOWS&query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&query_indicator=AVG_SHOW_POSITION&date_from=${from}&date_to=${today}&limit=25`, token),
      yFetch(`${p}/recrawl/quota/`, token),
      yFetch(`${p}/search-queries/all/history/?query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&query_indicator=AVG_SHOW_POSITION&date_from=${from}&date_to=${today}`, token),
      yFetch(`${p}/diagnostics/`, token),
    ]);

    // Merge the per-indicator date arrays into one chart-friendly series
    // (clicks, impressions and — when available — the daily average position).
    let series: { date: string; clicks: number; impressions: number; position?: number }[] = [];
    if (history.ok) {
      const ind = history.body.indicators ?? {};
      const byDate = new Map<string, { date: string; clicks: number; impressions: number; position?: number }>();
      const get = (d: string) => byDate.get(d) ?? { date: d, clicks: 0, impressions: 0 };
      for (const pnt of ind.TOTAL_SHOWS ?? []) {
        const d = String(pnt.date).slice(0, 10);
        byDate.set(d, { ...get(d), impressions: Math.round(pnt.value ?? 0) });
      }
      for (const pnt of ind.TOTAL_CLICKS ?? []) {
        const d = String(pnt.date).slice(0, 10);
        byDate.set(d, { ...get(d), clicks: Math.round(pnt.value ?? 0) });
      }
      for (const pnt of ind.AVG_SHOW_POSITION ?? []) {
        const d = String(pnt.date).slice(0, 10);
        const v = Number(pnt.value);
        byDate.set(d, { ...get(d), position: isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : undefined });
      }
      series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    // Diagnostics: surface only problems that are actually PRESENT, sorted by severity.
    let problems: { code: string; severity: string }[] = [];
    if (diagnostics.ok) {
      const probs = diagnostics.body.problems ?? {};
      problems = Object.entries(probs)
        .filter(([, v]: [string, any]) => v?.state === "PRESENT")
        .map(([code, v]: [string, any]) => ({ code, severity: v.severity ?? "POSSIBLE_PROBLEM" }))
        .sort((a, b) => (a.severity === "FATAL" ? -1 : a.severity === "CRITICAL" ? 0 : 1) - (b.severity === "FATAL" ? -1 : b.severity === "CRITICAL" ? 0 : 1));
    }

    return NextResponse.json({
      hostId: host.hostId,
      summary: summary.ok ? summary.body : null,
      queries: queries.ok ? (queries.body.queries ?? []) : [],
      recrawlQuota: quota.ok ? quota.body : null,
      series,
      problems,
    });
  } catch (e: any) {
    console.error("[yandex GET]", e);
    return NextResponse.json({ error: e?.message ?? "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const workspaceId = await workspaceUserId("act");
    if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const b = await req.json().catch(() => ({}));
    const action = String(b.action ?? "");
    const siteUrl = String(b.siteUrl ?? "");
    const token = String(b.token ?? "");
    if (!siteUrl || !token) return NextResponse.json({ error: "Missing siteUrl or token" }, { status: 400 });

    const host = await resolveHost(token, siteUrl);
    if (host.error) return NextResponse.json({ error: host.error }, { status: host.error === "invalid_token" ? 401 : 400 });
    const p = `/user/${host.userId}/hosts/${encodeURIComponent(host.hostId!)}`;

    if (action === "sitemap") {
      const sitemapUrl = String(b.sitemapUrl ?? "");
      if (!sitemapUrl) return NextResponse.json({ error: "Missing sitemapUrl" }, { status: 400 });
      const r = await yFetch(`${p}/user-added-sitemaps/`, token, { method: "POST", body: JSON.stringify({ url: sitemapUrl }) });
      // 409 = sitemap already added — treat as success for idempotent UX.
      if (r.ok || r.status === 409) return NextResponse.json({ ok: true, alreadyAdded: r.status === 409 });
      return NextResponse.json({ error: r.body?.error_message ?? `yandex ${r.status}` }, { status: 400 });
    }

    if (action === "recrawl") {
      const urls: string[] = (Array.isArray(b.urls) ? b.urls : []).map(String).filter((u: string) => u.startsWith("http")).slice(0, 10);
      if (!urls.length) return NextResponse.json({ error: "Missing urls" }, { status: 400 });
      const results: { url: string; ok: boolean; error?: string }[] = [];
      for (const url of urls) {
        const r = await yFetch(`${p}/recrawl/queue/`, token, { method: "POST", body: JSON.stringify({ url }) });
        results.push({ url, ok: r.ok, ...(r.ok ? {} : { error: r.body?.error_message ?? `yandex ${r.status}` }) });
      }
      return NextResponse.json({ ok: results.some(r => r.ok), results });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (e: any) {
    console.error("[yandex POST]", e);
    return NextResponse.json({ error: e?.message ?? "Internal server error" }, { status: 500 });
  }
}
