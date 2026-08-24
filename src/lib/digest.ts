// Digest builder. Produces a single structured DigestData object (the source of truth) and
// renders a compact Markdown summary from it. The Markdown is what goes to Telegram/Slack
// (kept under ~4000 chars); the structured data powers the rich in-app digest page, which can
// show the FULL lists (all striking-distance queries, every attention site, etc.) and split
// the view per search engine (Google / Bing / Yandex).
//
// Google numbers come from the local store (DailyMetric, TrackedKeyword). Bing/Yandex numbers
// are fetched live (digestEngines.ts) only when requested — the page loads them lazily per tab.

import { prisma } from "@/lib/prisma";
import { buildEngineData, type EngineRow } from "@/lib/digestEngines";
import { fetchLLM } from "@/lib/llm";
import { NOTIFY_L, normalizeLang, type NotifyLang } from "@/lib/notifyI18n";
import { buildBacklinkDigest, BASELINE_WINDOW_DAYS, type DigestBacklinks } from "@/lib/backlinkDigest";
import { rawQuery, rawExec } from "@/lib/db/raw";

export interface DigestSettings {
  enabled: boolean;
  frequency: "daily" | "weekly";
  hourUtc: number;   // 0-23
  tag: string;       // "" = all sites
  days: number;      // window length
  ai: boolean;       // add AI summary paragraph
  lang: NotifyLang;  // language of the rendered digest (saved from the UI language)
  lastSentAt?: string;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  enabled: false, frequency: "weekly", hourUtc: 8, tag: "", days: 7, ai: false, lang: "en",
};

// ─── Structured digest data (source of truth for both Markdown + the rich page) ───
export interface DigestSiteRow { id: string; name: string; cur: number; prev: number; impr: number; d: number; pctNum: number }
export interface DigestQueryRow { q: string; cur: number; prev: number; d: number }
export interface DigestStriking { query: string; site: string; pos: number; impr: number }
export interface DigestAttention { name: string; pct: number }
export interface DigestRankMove { keyword: string; from: number; to: number; d: number }

export interface DigestData {
  tag: string;
  lang: NotifyLang;
  sites: number;
  showDelta: boolean;
  period: { days: number; from: string; to: string; prevFrom: string; prevTo: string; allTime: boolean };
  portfolio: { counted: number; up: number; down: number; clicks: number; prevClicks: number; impr: number; prevImpr: number };
  gainers: DigestSiteRow[];
  losers: DigestSiteRow[];
  topSites: DigestSiteRow[];        // all-time mode (no deltas)
  winnersQ: DigestQueryRow[];
  losersQ: DigestQueryRow[];
  striking: DigestStriking[];
  strikingCount: number;
  attention: DigestAttention[];
  rankMoves: DigestRankMove[];
  /** null — модуль ссылок ничего не знает про этот портфель, секция не рисуется */
  backlinks: DigestBacklinks | null;
  engines: { bing: EngineRow[]; yandex: EngineRow[] };
}

export async function getDigestSettings(userId: string): Promise<DigestSettings> {
  try {
    const rows: any[] = await rawQuery(`SELECT digestSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.digestSettings;
    return raw ? { ...DEFAULT_DIGEST_SETTINGS, ...JSON.parse(raw) } : DEFAULT_DIGEST_SETTINGS;
  } catch {
    return DEFAULT_DIGEST_SETTINGS;
  }
}

export async function saveDigestSettings(userId: string, s: DigestSettings): Promise<void> {
  await rawExec(`UPDATE "User" SET digestSettings = ? WHERE id = ?`, JSON.stringify(s), userId);
}

const hasTag = (tagsField: string | null, tag: string): boolean => {
  if (!tagsField) return false;
  try {
    const arr = JSON.parse(tagsField);
    if (Array.isArray(arr)) return arr.map(String).map(s => s.toLowerCase()).includes(tag.toLowerCase());
  } catch { /* comma-separated fallback */ }
  return tagsField.toLowerCase().split(",").map(s => s.trim()).includes(tag.toLowerCase());
};

const clean = (u: string) => u.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, "");
const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const fmtNum = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};
const pctNum = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);
const pctStr = (cur: number, prev: number) => (prev > 0 ? `${sign(pctNum(cur, prev))}%` : cur > 0 ? "new" : "0%");

// How many items each section keeps in the FULL structured data (the page shows these,
// with "show more"). Markdown uses much smaller sub-slices to stay Telegram-sized.
const FULL = {
  movers: 50, queries: 50, striking: 200, attention: 50, rankMoves: 60,
  // Ссылки: избранные держим поимённо, доноров — верхушкой. Событий берём с запасом,
  // потому что счёт потерь должен быть точным, а не «первой страницей».
  backlinkFavorites: 50, backlinkDomains: 25, backlinkEvents: 20_000,
};

// Какие виды событий вообще попадают в дайджест. target_changed сюда не входит:
// это повод для алерта по избранной ссылке, а не строка в сводке за неделю.
const DIGEST_EVENT_KINDS = ["appeared", "returned", "lost", "rel_downgraded"];

// Домен-цель BacklinkSnapshot: там ключ — голый хост, а не URL сайта.
const targetOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];

// ─── Build the structured data ────────────────────────────────────────────────
export async function buildDigestData(
  userId: string, tag: string, days: number, lang: NotifyLang = "en",
  opts: { engineCap?: number } = {},
): Promise<DigestData> {
  const allSites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true, tags: true } });
  const sites = tag ? allSites.filter(s => hasTag(s.tags, tag)) : allSites;

  const now = new Date();
  const curStart = new Date(now); curStart.setDate(curStart.getDate() - days);
  const prevStart = new Date(now); prevStart.setDate(prevStart.getDate() - days * 2);
  const siteIds = sites.map(s => s.id);
  const showDelta = days > 0;
  const effectiveCurStart = days === 0 ? new Date("2000-01-01") : curStart;
  const effectivePrevStart = days === 0 ? new Date("2000-01-01") : prevStart;

  const base: DigestData = {
    tag, lang: normalizeLang(lang), sites: sites.length, showDelta,
    period: { days, from: day(curStart), to: day(now), prevFrom: day(prevStart), prevTo: day(curStart), allTime: days === 0 },
    portfolio: { counted: 0, up: 0, down: 0, clicks: 0, prevClicks: 0, impr: 0, prevImpr: 0 },
    gainers: [], losers: [], topSites: [], winnersQ: [], losersQ: [], striking: [], strikingCount: 0, attention: [], rankMoves: [],
    backlinks: null,
    engines: { bing: [], yandex: [] },
  };
  if (!siteIds.length) return base;

  const dateOnly = { url: "", query: "" };
  const nameOf = new Map(sites.map(s => [s.id, clean(s.url)]));

  // ── per-site traffic (one grouped query per period; scoped to date-only totals so the
  // three DailyMetric row kinds don't triple-count)
  const siteAgg = (gte: Date, lt?: Date) => prisma.dailyMetric.groupBy({
    by: ["siteId"],
    where: { siteId: { in: siteIds }, ...dateOnly, date: lt ? { gte, lt } : { gte, lte: now } },
    _sum: { clicks: true, impressions: true },
  });
  const [curSites, prevSites] = await Promise.all([
    siteAgg(effectiveCurStart, undefined),
    showDelta ? siteAgg(effectivePrevStart, effectiveCurStart) : Promise.resolve([] as any[]),
  ]);
  const prevBySite = new Map<string, number>(prevSites.map((r: any) => [r.siteId, r._sum.clicks ?? 0]));
  base.portfolio.prevImpr = (prevSites as any[]).reduce((s, r) => s + (r._sum.impressions ?? 0), 0);
  const perSite: DigestSiteRow[] = curSites.map((r: any) => {
    const cur = r._sum.clicks ?? 0, prev = prevBySite.get(r.siteId) ?? 0;
    return { id: r.siteId, name: nameOf.get(r.siteId) ?? r.siteId, cur, impr: r._sum.impressions ?? 0, prev, d: cur - prev, pctNum: pctNum(cur, prev) };
  });
  for (const [id, prev] of prevBySite) if (!perSite.some(p => p.id === id) && prev > 0) {
    perSite.push({ id, name: nameOf.get(id) ?? id, cur: 0, impr: 0, prev, d: -prev, pctNum: -100 });
  }

  base.portfolio.clicks = perSite.reduce((s, x) => s + x.cur, 0);
  base.portfolio.prevClicks = perSite.reduce((s, x) => s + x.prev, 0);
  base.portfolio.impr = perSite.reduce((s, x) => s + x.impr, 0);
  base.portfolio.counted = perSite.length;

  const significant = (p: { cur: number; prev: number }) => {
    const d = p.cur - p.prev;
    return Math.abs(d) >= 5 && (p.prev === 0 ? p.cur >= 5 : Math.abs(d) / p.prev >= 0.1);
  };
  base.portfolio.up = showDelta ? perSite.filter(p => p.cur > p.prev && significant(p)).length : 0;
  base.portfolio.down = showDelta ? perSite.filter(p => p.cur < p.prev && significant(p)).length : 0;

  if (showDelta) {
    const sig = perSite.filter(significant);
    base.gainers = sig.filter(p => p.d > 0).sort((a, b) => b.d - a.d).slice(0, FULL.movers);
    base.losers = sig.filter(p => p.d < 0).sort((a, b) => a.d - b.d).slice(0, FULL.movers);
  } else {
    base.topSites = [...perSite].sort((a, b) => b.cur - a.cur).slice(0, FULL.movers);
  }

  // ── winners / losers queries across the portfolio/tag
  const agg = (gte: Date, lt?: Date) => prisma.dailyMetric.groupBy({
    by: ["query"],
    where: { siteId: { in: siteIds }, date: lt ? { gte, lt } : { gte, lte: now }, query: { not: "" } },
    _sum: { clicks: true },
  });
  const [curQ, prevQ] = await Promise.all([agg(effectiveCurStart, undefined), showDelta ? agg(effectivePrevStart, effectiveCurStart) : Promise.resolve([])]);
  const prevMap = new Map<string, number>(prevQ.map(r => [r.query, r._sum.clicks ?? 0] as [string, number]));
  const curMap = new Map<string, number>(curQ.map(r => [r.query, r._sum.clicks ?? 0] as [string, number]));
  const qDeltas: DigestQueryRow[] = [];
  for (const [q, c] of curMap) qDeltas.push({ q, cur: c, prev: prevMap.get(q) ?? 0, d: c - (prevMap.get(q) ?? 0) });
  for (const [q, p] of prevMap) if (!curMap.has(q)) qDeltas.push({ q, cur: 0, prev: p, d: -p });
  base.winnersQ = qDeltas.filter(x => x.d > 0).sort((a, b) => b.d - a.d).slice(0, FULL.queries);
  base.losersQ = qDeltas.filter(x => x.d < 0).sort((a, b) => a.d - b.d).slice(0, FULL.queries);

  // ── Striking distance (near-page-1 opportunities)
  try {
    const strk = await prisma.dailyMetric.groupBy({
      by: ["siteId", "query"],
      where: { siteId: { in: siteIds }, date: { gte: effectiveCurStart, lte: now }, query: { not: "" }, position: { gte: 4, lte: 20 } },
      _sum: { impressions: true }, _avg: { position: true },
      having: { impressions: { _sum: { gte: 20 } } },
      orderBy: { _sum: { impressions: "desc" } },
      take: FULL.striking,
    });
    base.strikingCount = strk.length;
    base.striking = strk.map(r => ({
      query: r.query, site: nameOf.get(r.siteId) ?? "",
      pos: Math.round((r._avg.position ?? 0) * 10) / 10, impr: r._sum.impressions ?? 0,
    }));
  } catch { /* best-effort on huge portfolios */ }

  // ── Sites needing attention: biggest % traffic drops
  if (showDelta) {
    base.attention = perSite
      .filter(p => p.prev >= 30 && p.cur < p.prev * 0.7)
      .map(p => ({ name: p.name, pct: Math.round((1 - p.cur / p.prev) * 100) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, FULL.attention);
  }

  // ── rank tracker movements
  const kws = await prisma.trackedKeyword.findMany({
    where: { siteId: { in: siteIds }, lastPosition: { not: null }, prevPosition: { not: null } },
  });
  base.rankMoves = kws
    .map(k => ({ keyword: k.keyword, from: k.prevPosition ?? 0, to: k.lastPosition ?? 0, d: (k.prevPosition ?? 0) - (k.lastPosition ?? 0) }))
    .filter(x => x.d !== 0)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, FULL.rankMoves);

  // ── Links: what appeared and what went away.
  // Counted from SiteBacklinkEvent rows inside the window — never from SiteBacklink itself,
  // which holds a running total and would make every digest repeat the same losses forever.
  try {
    const baselineFrom = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000);
    const targets = [...new Set(sites.map(x => targetOf(x.url)))];
    const [rawEvents, syncs, completeSyncs, snapRows] = await Promise.all([
      prisma.siteBacklinkEvent.findMany({
        where: { siteId: { in: siteIds }, createdAt: { gte: effectiveCurStart, lte: now }, kind: { in: DIGEST_EVENT_KINDS } },
        orderBy: { createdAt: "desc" }, take: FULL.backlinkEvents,
      }),
      // Прогоны, пересекающие окно: по ним событие привязывается к своему прогону
      // и выясняется, была ли выгрузка полной.
      prisma.siteBacklinkSync.findMany({
        where: { siteId: { in: siteIds }, startedAt: { lte: now }, OR: [{ finishedAt: null }, { finishedAt: { gte: effectiveCurStart } }] },
        select: { siteId: true, kind: true, status: true, complete: true, startedAt: true, finishedAt: true },
      }),
      // Был ли у сайта хоть один завершённый полный прогон — до этого о потерях молчим.
      prisma.siteBacklinkSync.findMany({
        where: { siteId: { in: siteIds }, status: "completed", complete: true },
        select: { siteId: true }, distinct: ["siteId"],
      }),
      prisma.backlinkSnapshot.findMany({
        where: { target: { in: targets }, date: { gte: day(baselineFrom) } },
        select: { target: true, date: true, backlinks: true },
      }),
    ]);

    // Один и тот же (target, date) может прийти от нескольких провайдеров — сначала
    // схлопываем внутри цели, потом складываем цели в один портфельный ряд.
    const perTargetDate = new Map<string, number>();
    for (const r of snapRows) {
      if (typeof r.backlinks !== "number") continue;
      const k = `${r.target}|${r.date}`;
      perTargetDate.set(k, Math.max(perTargetDate.get(k) ?? 0, r.backlinks));
    }
    const byDate = new Map<string, number>();
    for (const [k, v] of perTargetDate) {
      const date = k.slice(k.indexOf("|") + 1);
      byDate.set(date, (byDate.get(date) ?? 0) + v);
    }
    const snapshots = [...byDate.entries()].map(([date, backlinks]) => ({ date, backlinks }));

    // Событие знает только backlinkId; имя ссылки и признак «избранная» — в самой строке.
    const ids = [...new Set(rawEvents.map(e => e.backlinkId))];
    const linkRows = ids.length
      ? await prisma.siteBacklink.findMany({ where: { id: { in: ids } }, select: { id: true, urlFrom: true, domainFrom: true, favorite: true } })
      : [];
    const linkById = new Map(linkRows.map(r => [r.id, r]));

    const section = buildBacklinkDigest({
      events: rawEvents.map(e => {
        const r = linkById.get(e.backlinkId);
        return {
          id: e.id, siteId: e.siteId, kind: e.kind, origin: e.origin, createdAt: e.createdAt,
          favorite: r?.favorite ?? false, urlFrom: r?.urlFrom ?? "", domainFrom: r?.domainFrom ?? "",
        };
      }),
      syncs,
      completeExportSites: completeSyncs.map(r => r.siteId),
      snapshots,
      periodDays: days || 1,
      limits: { favorites: FULL.backlinkFavorites, lossDomains: FULL.backlinkDomains },
    }, now);

    // В режиме «всё время» окно накрывает всю историю: сравнивать такую сумму с суточной
    // нормой бессмысленно, поэтому вердикт об аномалии там не выносится.
    base.backlinks = section.hasData ? (showDelta ? section : { ...section, anomaly: null, baselineReady: false }) : null;
  } catch { /* таблицы Backlinks v2 ещё не мигрированы — секции просто нет */ }

  // ── live Bing/Yandex (only when requested; bounded by cap)
  if (opts.engineCap && opts.engineCap > 0) {
    try { base.engines = await buildEngineData(userId, sites, days || 28, opts.engineCap); }
    catch { /* engines are best-effort */ }
  }

  return base;
}

// ─── Render the compact Markdown (Telegram/Slack) from the structured data ──────
export function renderDigestMarkdown(data: DigestData): string {
  const L = NOTIFY_L[normalizeLang(data.lang)];
  const lines: string[] = [];
  lines.push(`*${data.tag ? L.digestTitleTag(data.tag) : L.digestTitleAll}*`);
  lines.push(data.period.allTime ? `_${L.allTime} · ${data.period.to}_` : L.digestRange(data.period.from, data.period.to));

  if (!data.sites) { lines.push("", data.tag ? L.digestNoSitesTag(data.tag) : L.digestNoSites); return lines.join("\n"); }

  const P = data.portfolio;
  lines.push("");
  if (data.showDelta) lines.push(L.portfolio(P.counted, P.up, P.down));
  lines.push(L.clicksLine(fmtNum(P.clicks), data.showDelta ? pctStr(P.clicks, P.prevClicks) : "—", fmtNum(P.impr), data.showDelta ? pctStr(P.impr, P.prevImpr) : "—"));

  if (data.showDelta) {
    if (data.gainers.length) { lines.push("", L.topGainers); for (const s of data.gainers.slice(0, 8)) lines.push(`🟢 ${s.name} — ${fmtNum(s.cur)} (${sign(s.d)}, ${pctStr(s.cur, s.prev)})`); }
    if (data.losers.length) { lines.push("", L.topLosers); for (const s of data.losers.slice(0, 8)) lines.push(`🔴 ${s.name} — ${fmtNum(s.cur)} (${sign(s.d)}, ${pctStr(s.cur, s.prev)})`); }
  } else if (data.topSites.length) {
    lines.push("", L.topGainers);
    for (const s of data.topSites.slice(0, 15)) lines.push(`${s.name} — ${fmtNum(s.cur)} ${L.unitClicks} · ${fmtNum(s.impr)} ${L.unitImpr}`);
  }

  if (data.winnersQ.length) { lines.push("", L.winners); for (const w of data.winnersQ.slice(0, 8)) lines.push(`  ${w.q} — ${w.cur} (${sign(w.d)})`); }
  if (data.losersQ.length) { lines.push("", L.losers); for (const l of data.losersQ.slice(0, 8)) lines.push(`  ${l.q} — ${l.cur} (${sign(l.d)})`); }

  if (data.striking.length) {
    lines.push("", L.strikingHdr(data.strikingCount));
    for (const r of data.striking.slice(0, 8)) lines.push(L.strikingRow(r.query, r.site, String(r.pos), fmtNum(r.impr)));
    if (data.strikingCount > 8) lines.push(L.digestMore(data.strikingCount - 8));
  }

  if (data.attention.length) {
    lines.push("", L.attentionHdr);
    for (const d of data.attention.slice(0, 6)) lines.push(L.attentionDrop(d.name, d.pct));
    if (data.attention.length > 6) lines.push(L.digestMore(data.attention.length - 6));
  }

  if (data.rankMoves.length) {
    lines.push("", L.rankMoves);
    for (const m of data.rankMoves.slice(0, 10)) lines.push(`  ${m.d > 0 ? "▲" : "▼"} ${m.keyword}: ${m.from} → ${m.to}`);
  }

  const B = data.backlinks;
  if (B) {
    lines.push("", L.dglSectionTitle);
    // Потери показываем только когда их вообще позволено считать (CONTRACT §4).
    if (B.lossesReported) {
      // Минус здесь типографский (−), как и в остальной строке, а не дефис из sign().
      const net = B.net > 0 ? `+${B.net}` : B.net < 0 ? `−${-B.net}` : "0";
      lines.push(`  +${B.appeared} ${L.dglNew} · −${B.lost} ${L.dglLost} · ${net} ${L.dglNet}`);
    } else {
      lines.push(`  +${B.appeared} ${L.dglNew}`);
      lines.push(L.dglNoFullExport);
    }
    // Избранные — всегда поимённо, даже если потеряна одна: дорогая ссылка не должна
    // утонуть в агрегате.
    if (B.favoriteLost.length) {
      lines.push(L.dglFavoriteLost(B.favoriteLost.slice(0, 10).map(l => l.url).join(", ")));
      if (B.favoriteLost.length > 10) lines.push(L.digestMore(B.favoriteLost.length - 10));
    }
    if (B.favoriteDowngraded.length) {
      lines.push(L.dglFavoriteDowngraded(B.favoriteDowngraded.slice(0, 10).map(l => l.url).join(", ")));
      if (B.favoriteDowngraded.length > 10) lines.push(L.digestMore(B.favoriteDowngraded.length - 10));
    }
    if (B.relDowngraded) lines.push(L.dglRelDowngrade(B.relDowngraded));
    if (B.topLossDomains.length) lines.push(L.dglTopLossDomains(B.topLossDomains.slice(0, 5).map(d => `${d.domain} (${d.n})`).join(", ")));
    if (B.lossesReported && !B.baselineReady) lines.push(L.dglBaselineBuilding);
    if (B.anomaly?.anomalous) lines.push(L.dglAnomaly, L.dglAnomalyHint(B.anomaly.lost, B.anomaly.timesLabel));
    if (!B.appeared && !B.lost && !B.relDowngraded) lines.push(L.dglNoChange);
  }

  for (const [name, rows] of [["Bing", data.engines.bing], ["Яндекс", data.engines.yandex]] as [string, EngineRow[]][]) {
    if (!rows.length) continue;
    const tc = rows.reduce((s, r) => s + r.clicks, 0), ti = rows.reduce((s, r) => s + r.impr, 0);
    if (!tc && !ti) continue;
    lines.push("", L.engineHdr(name), L.engineTotals(fmtNum(tc), fmtNum(ti)));
    for (const s of [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, 3)) lines.push(L.engineTopSite(s.name, fmtNum(s.clicks), fmtNum(s.impr)));
  }

  return lines.join("\n");
}

// Back-compat wrapper: returns the Markdown (with engines, for Telegram) + the structured data.
export async function buildDigest(
  userId: string, tag: string, days: number, lang: NotifyLang = "en",
  opts: { engineCap?: number } = { engineCap: 25 },
): Promise<{ content: string; sites: number; data: DigestData }> {
  const data = await buildDigestData(userId, tag, days, lang, opts);
  return { content: renderDigestMarkdown(data), sites: data.sites, data };
}

// Optional AI paragraph on top of the numbers — uses the server-side backup of the
// user's own AI key (User.seoSettings); silently skipped when no key is configured.
export async function aiSummary(userId: string, digestMarkdown: string, lang: NotifyLang = "en"): Promise<string | null> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const s = rows?.[0]?.seoSettings ? JSON.parse(rows[0].seoSettings) : null;
    if (!s) return null;
    const provider = s.seoProvider || s.aiProvider || "anthropic";
    const apiKey = s[`aiKey_${provider}`] || s.aiApiKey || "";
    if (!apiKey) return null;
    const model = s.seoModel || s[`aiModel_${provider}`] || undefined;
    const langName = lang === "ru" ? "Russian"
      : lang === "uk" ? "Ukrainian"
      : lang === "fr" ? "French"
      : lang === "es" ? "Spanish"
      : lang === "de" ? "German"
      : lang === "zh" ? "Simplified Chinese"
      : "English";
    const text = await fetchLLM(
      `You are a senior SEO analyst reviewing a multi-site portfolio digest. Write in ${langName}.\n\n` +
      `Rules:\n` +
      `- Be SPECIFIC: name the exact site domains and queries from the data, never generalize into "some projects".\n` +
      `- Structure: (1) one line on overall portfolio direction with the % change; (2) which specific sites drove gains and which drove losses — name them; (3) 3-5 concrete prioritized actions tied to the data (which site to investigate first, which striking-distance queries to push, which pages to optimize for CTR).\n` +
      `- Prefer bullet points for the actions. No fluff, no repeating the whole table, no invented facts.\n\n` +
      `DIGEST DATA:\n${digestMarkdown.slice(0, 14_000)}`,
      provider, apiKey, 1000, model, s.aiBaseUrl_custom || undefined,
    );
    return text ? `${NOTIFY_L[normalizeLang(lang)].aiSummary}\n${text.trim()}` : null;
  } catch {
    return null;
  }
}
