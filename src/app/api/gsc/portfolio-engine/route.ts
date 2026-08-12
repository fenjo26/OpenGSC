import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { getOwnerSettings, listEngineKeys } from "@/lib/engineKeysServer";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// Live portfolio for Bing / Yandex. Unlike the Google portfolio (which lists the sites in our
// DB), this enumerates the engine's OWN verified sites — across every connected account —
// because a user may have sites in Bing/Yandex that were never added to Google. Each site is
// returned in the SAME per-site shape as /api/gsc/portfolio so the dashboard renders it through
// the identical UI. Where an engine site matches a DB site by domain, we reuse that DB id so
// tags/favorites carry over; otherwise it gets a synthetic id.
//
// Cost: Bing = 1 GetUserSites/key + 1 traffic call/site. Yandex = 1 user + 1 hosts/token + 1
// history/site. Concurrency-limited; the client caches the result per engine+period.

function periodToDays(period: string): number {
  const today = new Date();
  const map: Record<string, number> = {
    yesterday: 1, "7d": 7, "14d": 14, "28d": 28, last_week: 7,
    this_month: today.getDate(), last_month: new Date(today.getFullYear(), today.getMonth(), 0).getDate(),
    this_quarter: 90, last_quarter: 90,
    ytd: Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000),
    "3m": 90, "6m": 180, "8m": 240, "12m": 365, "16m": 480, "2y": 730, "3y": 1095,
  };
  return map[period] ?? 28;
}
const pct = (curr: number, prev: number) => (prev === 0 ? 0 : Math.round(((curr - prev) / prev) * 100));
const clean = (u: string) => u.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/.*$/, "");
const dstr = (d: Date) => d.toISOString().slice(0, 10);
const parseBingDate = (v: any): string => { const m = String(v ?? "").match(/\/Date\((\d+)/); return m ? new Date(parseInt(m[1], 10)).toISOString().slice(0, 10) : String(v).slice(0, 10); };

type Daily = { date: string; clicks: number; impressions: number; ctr: number; position: number }; // ctr as fraction

// fetch with retries + a generous timeout — portfolio pulls hit each engine 100+ times, so a
// single transient timeout/429 must not silently drop a site's data.
async function fetchRetry(url: string, init: RequestInit = {}, tries = 3, timeoutMs = 20_000): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return r;
      if (r.status !== 429 && r.status < 500) return r; // 4xx (bad key/site) — no point retrying
    } catch { /* network / timeout → retry */ }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 500 * (i + 1)));
  }
  return null;
}

// Fetch + parse JSON, retrying when the response is 200 OK but the extracted payload is EMPTY.
// Bing/Yandex throttle heavy batch pulls by returning a valid-but-empty body (no error), which
// plain retry-on-error never catches — this is what silently blanked some sites.
async function fetchNonEmpty(url: string, init: RequestInit, isEmpty: (j: any) => boolean, tries = 4): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetchRetry(url, init, 2);
    if (r && r.ok) {
      const j = await r.json().catch(() => null);
      if (j && !isEmpty(j)) return j;
    } else if (r && r.status < 500 && r.status !== 429) {
      return null; // 4xx (bad key/site) — genuinely nothing to get
    }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 700 * (i + 1)));
  }
  return null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = undefined; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function buildPayload(site: any, curr: Daily[], prev: Daily[], days: number) {
  const norm = (arr: number[]) => { const lo = Math.min(...arr, 0), hi = Math.max(...arr, 1); return arr.map(v => (hi === lo ? 50 : Math.round(((v - lo) / (hi - lo)) * 85 + 5))); };
  const sum = (rows: Daily[]) => rows.reduce((a, m) => ({ clicks: a.clicks + m.clicks, impressions: a.impressions + m.impressions, ctr: a.ctr + m.ctr, position: a.position + m.position, n: a.n + 1 }), { clicks: 0, impressions: 0, ctr: 0, position: 0, n: 0 });
  const c = sum(curr), p = sum(prev);
  const avgCtr = (s: typeof c) => (s.n > 0 ? +((s.ctr / s.n) * 100).toFixed(2) : 0);
  const avgPos = (rows: Daily[]) => { const pts = rows.filter(r => r.position > 0); return pts.length ? +(pts.reduce((a, r) => a + r.position, 0) / pts.length).toFixed(1) : 0; };
  const summary = {
    clicks: { value: c.clicks, change: pct(c.clicks, p.clicks) },
    impressions: { value: c.impressions, change: pct(c.impressions, p.impressions) },
    ctr: { value: avgCtr(c), change: pct(avgCtr(c), avgCtr(p)) },
    position: { value: avgPos(curr), change: pct(avgPos(curr), avgPos(prev)) },
  };
  const prevByDate = new Map(prev.map(r => [r.date, r]));
  const clicks = curr.map(r => r.clicks), impressions = curr.map(r => r.impressions);
  const ctrs = curr.map(r => +((r.ctr * 100).toFixed(2))), positions = curr.map(r => +r.position.toFixed(1));
  const clicksC: number[] = [], impressionsC: number[] = [], ctrsC: number[] = [], positionsC: number[] = [];
  for (const r of curr) {
    const shifted = new Date(r.date); shifted.setDate(shifted.getDate() - days);
    const pr = prevByDate.get(dstr(shifted));
    clicksC.push(pr?.clicks ?? 0); impressionsC.push(pr?.impressions ?? 0);
    ctrsC.push(pr ? +((pr.ctr * 100).toFixed(2)) : 0); positionsC.push(pr ? +pr.position.toFixed(1) : 0);
  }
  const nC = norm(clicks), nI = norm(impressions), nT = norm(ctrs), nP = norm(positions);
  const nCC = norm(clicksC), nIC = norm(impressionsC), nTC = norm(ctrsC), nPC = norm(positionsC);
  const data = curr.map((r, i) => ({
    date: r.date, clicks: r.clicks, impressions: r.impressions, ctr: ctrs[i], position: positions[i],
    clicksC: clicksC[i], impressionsC: impressionsC[i], ctrC: ctrsC[i], positionC: positionsC[i],
    cN: nC[i], iN: nI[i], tN: nT[i], pN: nP[i], cCN: nCC[i], iCN: nIC[i], tCN: nTC[i], pCN: nPC[i],
  }));
  return { ...site, data, summary, hasData: curr.some(r => r.clicks > 0 || r.impressions > 0) };
}

const splitWindows = (daily: Daily[], start: string, curEnd: string, prevStart: string, prevEnd: string) => ({
  curr: daily.filter(d => d.date >= start && d.date <= curEnd),
  prev: daily.filter(d => d.date >= prevStart && d.date <= prevEnd),
});

// ── Persistent cache (raw SQL so it works right after `prisma db push`, before generate) ──
async function readCache(userId: string, engine: string, period: string): Promise<{ sites: any[]; cachedAt: string } | null> {
  try {
    const rows: any[] = await rawQuery(`SELECT data, updatedAt FROM "EnginePortfolioCache" WHERE userId = ? AND engine = ? AND period = ?`, userId, engine, period);
    if (!rows?.[0]?.data) return null;
    return { sites: JSON.parse(rows[0].data), cachedAt: new Date(rows[0].updatedAt).toISOString() };
  } catch { return null; }
}
// Keep a site's last-known-good data if this rebuild came back empty for it (transient
// timeout/429). A site that previously had data never regresses to a blank card.
async function mergeSticky(userId: string, engine: string, period: string, fresh: any[]): Promise<any[]> {
  const prev = await readCache(userId, engine, period);
  if (!prev?.sites?.length) return fresh;
  const prevByKey = new Map<string, any>();
  for (const s of prev.sites) if (s?.hasData) { prevByKey.set(s.id, s); if (s.url) prevByKey.set(s.url, s); }
  return fresh.map(s => (s?.hasData ? s : (prevByKey.get(s?.id) ?? prevByKey.get(s?.url) ?? s)));
}

async function writeCache(userId: string, engine: string, period: string, sites: any[]): Promise<void> {
  try {
    const id = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) as string;
    await runUpsert({
      table: "EnginePortfolioCache",
      conflict: ["userId", "engine", "period"],
      values: { id, userId, engine, period, data: JSON.stringify(sites), updatedAt: new Date().toISOString() },
      update: { data: "set", updatedAt: "set" },
    });
  } catch { /* cache write is best-effort */ }
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const engine = searchParams.get("engine") === "yandex" ? "yandex" : "bing";
  const period = searchParams.get("period") || "7d";
  const refresh = searchParams.get("refresh") === "1";
  const days = periodToDays(period);

  // Serve the stored snapshot instantly unless a rebuild was explicitly requested.
  if (!refresh) {
    const cached = await readCache(userId, engine, period);
    if (cached) return NextResponse.json({ sites: cached.sites, engine, cachedAt: cached.cachedAt, cached: true });
  }

  const now = new Date();
  const curEnd = dstr(now);
  const start = dstr(new Date(now.getTime() - (days - 1) * 86_400_000));
  const prevEnd = dstr(new Date(now.getTime() - days * 86_400_000));
  const prevStart = dstr(new Date(now.getTime() - (2 * days - 1) * 86_400_000));

  const settings = await getOwnerSettings(userId);
  const keys = listEngineKeys(settings, engine);
  if (!keys.length) return NextResponse.json({ sites: [], engine, noKey: true });

  // Match engine sites to DB sites by domain so tags/favorites carry over.
  const dbSites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true, tags: true } });
  const dbByDomain = new Map<string, any>(dbSites.map((s: any) => [clean(s.url).replace(/^www\./, "").toLowerCase(), s]));
  const makeSite = (url: string) => {
    const dom = clean(url).replace(/^www\./, "").toLowerCase();
    const db = dbByDomain.get(dom);
    return db ? { id: db.id, url: db.url, tags: db.tags } : { id: `${engine}:${dom}`, url, tags: null };
  };

  if (engine === "bing") {
    // 1) Enumerate verified sites for each Bing key. 2) Fetch traffic per site with its key.
    const targets: { url: string; key: string }[] = [];
    const seen = new Set<string>();
    await Promise.all(keys.map(async (key) => {
      try {
        const r = await fetchRetry(`https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(key)}`);
        if (!r || !r.ok) return;
        const d: any[] = (await r.json())?.d ?? [];
        for (const s of d) {
          const url = String(s.Url ?? s.url ?? "");
          const dom = clean(url).replace(/^www\./, "").toLowerCase();
          if (url && !seen.has(dom)) { seen.add(dom); targets.push({ url, key }); }
        }
      } catch { /* skip this key */ }
    }));

    // Low concurrency + empty-retry to stay under Bing's throttle. Per site: traffic stats for
    // the daily series; then — only when the site actually has traffic — one query-stats call
    // for the impression-weighted avg position (Bing's daily AvgImpressionPosition is often 0,
    // so the reliable position comes from queries, exactly like the per-site engine view).
    const res = await pool(targets, 3, async ({ url, key }) => {
      const dom = clean(url);
      const api = (method: string) => `https://ssl.bing.com/webmaster/api.svc/json/${method}?siteUrl=${encodeURIComponent(`https://${dom}/`)}&apikey=${encodeURIComponent(key)}`;
      const j = await fetchNonEmpty(api("GetRankAndTrafficStats"), {}, x => !((x?.d ?? []).length));
      const rows: any[] = j?.d ?? [];
      const daily: Daily[] = rows.map(x => {
        const clicks = Number(x.Clicks) || 0, impressions = Number(x.Impressions) || 0;
        const posv = Number(x.AvgImpressionPosition ?? x.AvgClickPosition ?? 0);
        return { date: parseBingDate(x.Date), clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: posv > 0 ? posv : 0 };
      }).sort((a, b) => a.date.localeCompare(b.date));
      const { curr, prev } = splitWindows(daily, start, curEnd, prevStart, prevEnd);
      const payload = buildPayload(makeSite(url), curr, prev, days);
      // Avg position from query stats (weighted by impressions) when the series lacks it.
      if (payload.hasData && payload.summary && !payload.summary.position.value) {
        const qj = await fetchNonEmpty(api("GetQueryStats"), {}, x => !((x?.d ?? []).length));
        let ws = 0, wi = 0;
        for (const q of (qj?.d ?? [])) { const p = Number(q.AvgImpressionPosition ?? q.AvgClickPosition ?? 0); const im = Number(q.Impressions) || 0; if (p > 0 && im > 0) { ws += p * im; wi += im; } }
        if (wi > 0) payload.summary.position.value = +(ws / wi).toFixed(1);
      }
      return payload;
    });
    const sites = await mergeSticky(userId, engine, period, res.filter(Boolean));
    await writeCache(userId, engine, period, sites);
    return NextResponse.json({ sites, engine, cachedAt: new Date().toISOString() });
  }

  // Yandex: for each token, resolve user + hosts, then one history call per verified host.
  const BASE = "https://api.webmaster.yandex.net/v4";
  const targets: { url: string; token: string; uid: any; hostId: string }[] = [];
  const seen = new Set<string>();
  await Promise.all(keys.map(async (token) => {
    const headers = { Authorization: `OAuth ${token}`, "Content-Type": "application/json" };
    const yGet = async (path: string) => { const r = await fetchRetry(`${BASE}${path}`, { headers }); return r && r.ok ? r.json() : null; };
    try {
      const user = await yGet("/user/");
      if (!user?.user_id) return;
      const hostsBody = await yGet(`/user/${user.user_id}/hosts/`);
      for (const h of (hostsBody?.hosts ?? [])) {
        if (!h?.host_id) continue;
        const url = String(h.ascii_host_url ?? h.unicode_host_url ?? "");
        const dom = clean(url).replace(/^www\./, "").toLowerCase();
        if (url && !seen.has(dom)) { seen.add(dom); targets.push({ url, token, uid: user.user_id, hostId: h.host_id }); }
      }
    } catch { /* skip this token */ }
  }));

  const res = await pool(targets, 3, async ({ url, token, uid, hostId }) => {
    const headers = { Authorization: `OAuth ${token}`, "Content-Type": "application/json" };
    const path = `${BASE}/user/${uid}/hosts/${encodeURIComponent(hostId)}/search-queries/all/history/?query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&query_indicator=AVG_SHOW_POSITION&date_from=${prevStart}&date_to=${curEnd}`;
    const j = await fetchNonEmpty(path, { headers }, x => {
      const i = x?.indicators ?? {};
      return !((i.TOTAL_SHOWS ?? []).length || (i.TOTAL_CLICKS ?? []).length);
    });
    if (!j) return { ...makeSite(url), data: [], summary: null, hasData: false };
    const ind = j.indicators ?? {};
    const byDate = new Map<string, Daily>();
    const get = (d: string) => byDate.get(d) ?? { date: d, clicks: 0, impressions: 0, ctr: 0, position: 0 };
    for (const p of ind.TOTAL_SHOWS ?? []) { const d = String(p.date).slice(0, 10); byDate.set(d, { ...get(d), impressions: Math.round(p.value ?? 0) }); }
    for (const p of ind.TOTAL_CLICKS ?? []) { const d = String(p.date).slice(0, 10); byDate.set(d, { ...get(d), clicks: Math.round(p.value ?? 0) }); }
    for (const p of ind.AVG_SHOW_POSITION ?? []) { const d = String(p.date).slice(0, 10); const v = Number(p.value); byDate.set(d, { ...get(d), position: isFinite(v) && v > 0 ? v : 0 }); }
    const daily = [...byDate.values()].map(x => ({ ...x, ctr: x.impressions ? x.clicks / x.impressions : 0 })).sort((a, b) => a.date.localeCompare(b.date));
    const { curr, prev } = splitWindows(daily, start, curEnd, prevStart, prevEnd);
    return buildPayload(makeSite(url), curr, prev, days);
  });
  const sites = await mergeSticky(userId, engine, period, res.filter(Boolean));
  await writeCache(userId, engine, period, sites);
  return NextResponse.json({ sites, engine, cachedAt: new Date().toISOString() });
}
