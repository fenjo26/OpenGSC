
import { rawQuery } from "@/lib/db/raw";// Optional Bing/Yandex section for the portfolio digest. Runs ONLY if the user has an
// engine key stored server-side (User.seoSettings — the same snapshot SeoKeysSync backs up).
//
// Everything here is best-effort and strictly bounded so it can never slow down or break the
// core (Google) digest:
//   • capped at CAP sites per engine, concurrency-limited, per-request timeouts;
//   • the whole thing is wrapped in try/catch by the caller and returns [] on any failure.
// Bing costs 1 request/site; Yandex shares one /user + /hosts lookup then 1 request/site.
type Site = { id: string; url: string };
export type EngineRow = { name: string; clicks: number; impr: number };

const clean = (u: string) => u.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/.*$/, "");
// Concurrency-limited map that never throws (failed items become undefined).
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = undefined; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function readEngineKeys(userId: string): Promise<{ bing: string; yandex: string }> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = rows?.[0]?.seoSettings ? JSON.parse(rows[0].seoSettings) : {};
    const acc = (k: string) => { try { return JSON.parse(s[k] || "[]"); } catch { return []; } };
    const bing = (acc("seoKey_bing_accounts_list")[0]?.key || s["seoKey_bing"] || "").trim();
    const yandex = (acc("seoKey_yandex_accounts_list")[0]?.key || s["seoKey_yandex"] || "").trim();
    return { bing, yandex };
  } catch { return { bing: "", yandex: "" }; }
}

async function bingTotals(key: string, sites: Site[], days: number, cap: number): Promise<EngineRow[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const res = await pool(sites.slice(0, cap), 5, async (site): Promise<EngineRow | undefined> => {
    const dom = clean(site.url);
    const url = `https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?siteUrl=${encodeURIComponent(`https://${dom}/`)}&apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return undefined;
    const rows: any[] = (await r.json())?.d ?? [];
    let clicks = 0, impr = 0;
    for (const row of rows) {
      const m = String(row.Date ?? "").match(/\/Date\((\d+)/);
      const ts = m ? parseInt(m[1], 10) : 0;
      if (ts && ts < cutoff) continue;
      clicks += Number(row.Clicks) || 0;
      impr += Number(row.Impressions) || 0;
    }
    return { name: dom, clicks, impr };
  });
  return res.filter((x): x is EngineRow => !!x && (x.clicks > 0 || x.impr > 0));
}

async function yandexTotals(token: string, sites: Site[], days: number, cap: number): Promise<EngineRow[]> {
  const BASE = "https://api.webmaster.yandex.net/v4";
  const headers = { Authorization: `OAuth ${token}`, "Content-Type": "application/json" };
  const yGet = async (path: string) => {
    const r = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(12_000) });
    return r.ok ? r.json() : null;
  };
  const user = await yGet("/user/");
  if (!user?.user_id) return [];
  const uid = user.user_id;
  const hostsBody = await yGet(`/user/${uid}/hosts/`);
  const list: any[] = hostsBody?.hosts ?? [];
  if (!list.length) return [];

  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const hostname = (u: string) => clean(u).replace(/^www\./, "").toLowerCase();

  const res = await pool(sites.slice(0, cap), 4, async (site): Promise<EngineRow | undefined> => {
    const want = hostname(site.url);
    const matches = list.filter(h => String(h.ascii_host_url ?? h.unicode_host_url ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[:/].*$/, "").toLowerCase() === want);
    const best = matches.find(h => h.verified && String(h.ascii_host_url).startsWith("https")) ?? matches.find(h => h.verified) ?? matches[0];
    if (!best?.host_id) return undefined;
    const path = `/user/${uid}/hosts/${encodeURIComponent(best.host_id)}/search-queries/all/history/?query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&date_from=${from}&date_to=${today}`;
    const h = await yGet(path);
    const ind = h?.indicators ?? {};
    const sum = (arr: any[]) => (arr ?? []).reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
    return { name: clean(site.url), clicks: Math.round(sum(ind.TOTAL_CLICKS)), impr: Math.round(sum(ind.TOTAL_SHOWS)) };
  });
  return res.filter((x): x is EngineRow => !!x && (x.clicks > 0 || x.impr > 0));
}

// Which engines the user has a key for (so the page can show/hide the Bing/Yandex tabs).
export async function configuredEngines(userId: string): Promise<{ bing: boolean; yandex: boolean }> {
  const k = await readEngineKeys(userId);
  return { bing: !!k.bing, yandex: !!k.yandex };
}

// Live per-site totals for one engine (used by the digest page's lazy engine tabs).
export async function buildEngineRows(userId: string, engine: "bing" | "yandex", sites: Site[], days: number, cap = 100): Promise<EngineRow[]> {
  const period = days && days > 0 ? days : 28;
  try {
    const keys = await readEngineKeys(userId);
    if (engine === "bing") return keys.bing ? await bingTotals(keys.bing, sites, period, cap).catch(() => []) : [];
    return keys.yandex ? await yandexTotals(keys.yandex, sites, period, cap).catch(() => []) : [];
  } catch { return []; }
}

// Both engines at once (for the Telegram/Markdown summary — bounded cap).
export async function buildEngineData(userId: string, sites: Site[], days: number, cap = 25): Promise<{ bing: EngineRow[]; yandex: EngineRow[] }> {
  const period = days && days > 0 ? days : 28;
  try {
    const keys = await readEngineKeys(userId);
    if (!keys.bing && !keys.yandex) return { bing: [], yandex: [] };
    const [bing, yandex] = await Promise.all([
      keys.bing ? bingTotals(keys.bing, sites, period, cap).catch(() => []) : Promise.resolve([] as EngineRow[]),
      keys.yandex ? yandexTotals(keys.yandex, sites, period, cap).catch(() => []) : Promise.resolve([] as EngineRow[]),
    ]);
    return { bing, yandex };
  } catch { return { bing: [], yandex: [] }; }
}
