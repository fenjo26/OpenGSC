// Движок PBN: сканирование снимков, восстановление сайта на диск, применение кампании ссылок.
//
// Сеть — через тот же прокси-пул и cdxGate, что и /drops (web.archive.org душит датацентр-IP).
// Чистые решения (оценка, выбор места, анкоры, чистка) берём из score/place/anchors/clean —
// здесь только оркестровка, диск и сеть. Серверный модуль (fs), в клиент не импортируется.

import { promises as fs } from "node:fs";
import path from "node:path";
import { safeFetch, type SafeFetchOptions, type SafeFetchResponse } from "@/lib/security/safeFetch";
import { cdxGate } from "@/lib/drops/wayback";
import { loadProxyPool } from "@/lib/drops/store";
import { proxyConnector } from "@/lib/drops/proxyTransport";
import { buildCdxUrl, parseCdxJson, usableRows, rawSnapshotUrl, extractTitle, extractHtmlLang, extractMetaRefresh } from "@/lib/drops/toxicity/cdx";
import { fetchWaybackUrls } from "@/lib/drops/legacyUrls";
import { scoreSnapshot, pickBestSnapshot, type SnapshotMetrics, type SnapshotScore } from "./score";
import { cleanHtml } from "./clean";
import { findTextBlocks, choosePlacement, planRel, type Rel } from "./place";
export { planRel, renderPage, linksForPage, type RenderLink } from "./place";
import { planAnchors, type AnchorSpec, type AnchorShares } from "./anchors";

const ARCHIVE_ZONE = "web.archive.org";
const ARCHIVE_MIN_INTERVAL_MS = 1500;
export const DEFAULT_PAGE_CAP = 100;

export type PbnFetch = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResponse>;

/** Фетчер через прокси-пул пользователя, вежливый к зоне архива. Как в toxicity/stage.ts. */
export async function makePbnFetch(userId: string): Promise<PbnFetch> {
  const pool = await loadProxyPool(userId);
  return async (url, options) => {
    const lease = await pool.lease(ARCHIVE_ZONE, ARCHIVE_MIN_INTERVAL_MS);
    const via = lease.endpoint;
    try {
      return await safeFetch(url, { ...options, allowPrivate: false, ...(via ? { proxy: proxyConnector(via) } : {}) });
    } finally {
      lease.release(true);
    }
  };
}

const PARKING_RE = /(domain (?:is )?for sale|buy this domain|parked (?:free|by)|sedoparking|this domain may be for sale|coming soon|under construction|godaddy\.com\/domains)/i;

/** Видимый текст и число «страниц с текстом» считаем из HTML одной страницы. */
function pageText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SnapshotOption extends SnapshotScore {
  timestamp: string;
  date: string;
}

/**
 * Сканирование: годовая раскладка снимков, по лучшему кандидату каждого года берём голову
 * документа и считаем метрики. Возвращаем снимки со score (пустой список → no_snapshot у
 * pickBestSnapshot). Чистая оценка — в score.ts.
 */
export async function prescanDomain(domain: string, fetch: PbnFetch, maxSnapshots = 6): Promise<{ snapshots: SnapshotOption[]; best: ReturnType<typeof pickBestSnapshot> }> {
  const cdxRes = await cdxGate(() => fetch(buildCdxUrl(domain, { last: maxSnapshots, collapseTimestamp: 4 }), { timeoutMs: 15_000, maxBytes: 512 * 1024 }));
  const rows = cdxRes.status === 200 ? usableRows(parseCdxJson(await cdxRes.json())) : [];
  const metrics: SnapshotMetrics[] = [];
  const options: SnapshotOption[] = [];
  for (const row of rows.slice(0, maxSnapshots)) {
    const url = rawSnapshotUrl(row.timestamp, row.original);
    let html = "";
    try {
      const res = await cdxGate(() => fetch(url, { timeoutMs: 15_000, maxBytes: 96 * 1024, headers: { range: "bytes=0-98303" } }));
      if (res.status < 400) html = (await res.text()).slice(0, 120_000);
    } catch { /* снимок не отдался — учтём как пустой, честно */ }
    const text = pageText(html);
    const m: SnapshotMetrics = {
      timestamp: row.timestamp,
      pagesWithText: text.length > 150 ? 1 : 0,       // по одной голове; полный подсчёт — при restore
      textChars: text.length,
      title: extractTitle(html) || undefined,
      domain,
      redirects: Boolean(extractMetaRefresh(html, url)),
      parkingSignals: PARKING_RE.test(html),
    };
    metrics.push(m);
    const s = scoreSnapshot(m);
    options.push({ ...s, timestamp: row.timestamp, date: `${row.timestamp.slice(0, 4)}-${row.timestamp.slice(4, 6)}-${row.timestamp.slice(6, 8)}` });
  }
  return { snapshots: options, best: pickBestSnapshot(metrics) };
}

function safeDir(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
}

export function siteDiskDir(userId: string, domain: string): string {
  return path.join(process.cwd(), "data", "pbn", safeDir(userId), safeDir(domain));
}

/**
 * Смена снимка аннулирует прежнюю выкачку: если у сайта уже записан ДРУГОЙ snapshotTimestamp,
 * каталог на диске надо вычистить — иначе restoreSite засчитает лежащие файлы прошлого снимка
 * как восстановленные и склеит контент двух эпох. Тот же ts → каталог не трогаем
 * (возобновляемость). Вызывается там, где восстановление реально входит: POST /api/pbn/restore,
 * MCP pbn_restore и PATCH смены снимка.
 */
export async function wipeDirIfNewSnapshot(prevTs: string | null | undefined, nextTs: string, diskDir: string): Promise<boolean> {
  if (!prevTs || prevTs === nextTs) return false;
  await fs.rm(diskDir, { recursive: true, force: true });
  return true;
}

/** Относительный путь страницы → имя файла на диске. "/" → index.html, "/a/b" → a/b/index.html */
function pageFilePath(root: string, urlPath: string): string {
  let p = urlPath.split("?")[0].split("#")[0];
  if (!p || p === "/") return path.join(root, "index.html");
  p = p.replace(/^\/+/, "");
  if (p.endsWith("/")) p += "index.html";
  else if (!/\.[a-z0-9]{1,6}$/i.test(p)) p += "/index.html";
  // защита от выхода за корень
  const full = path.normalize(path.join(root, p));
  return (full === root || full.startsWith(root + path.sep)) ? full : path.join(root, "index.html");
}

const ASSET_CAP = 400;

/** Относительные ссылки на свои ассеты (img/script/link) — их и качаем из архива. */
function collectSameOriginAssets(html: string): string[] {
  const out = new Set<string>();
  const add = (u: string | undefined) => { if (u && !/^(https?:)?\/\//i.test(u) && !/^data:/i.test(u) && !/^javascript:/i.test(u)) out.add(u.split("#")[0]); };
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return [...out];
}

export interface RestoreResult {
  pagesRequested: number;
  pagesRestored: number;
  remaining: number;
  done: boolean;
  assetsRestored: number;
  assetsFailed: number;
  pagesFailed: { path: string; reason: string }[];
  cleanedStats: { archiveRefsRewritten: number; externalLinksStripped: number; trackersRemoved: number; jsLinksStripped: number; foreignAssetsStripped: number };
  pages: { path: string; title?: string; textChars: number; blocks: { tag: string; textLength: number }[]; status: string }[];
}

/**
 * Восстановление: список URL из CDX (капнут), выкачка снимка каждого на выбранную метку,
 * чистка cleanHtml, запись на диск, разметка блоков findTextBlocks. Отчёт — честный:
 * заказано/восстановлено/не скачалось с причинами (в отличие от WayForge, который рисует
 * заглушки и привирает число страниц).
 */
export async function restoreSite(
  domain: string,
  snapshotTimestamp: string,
  diskDir: string,
  fetch: PbnFetch,
  opts: { pageCap?: number; deadlineMs?: number } = {},
): Promise<RestoreResult> {
  const cap = Math.max(1, Math.min(opts.pageCap ?? DEFAULT_PAGE_CAP, 1000));
  const deadline = Date.now() + (opts.deadlineMs ?? 40_000);
  const urlsFetch = await fetchWaybackUrls(domain);
  const host = domain.replace(/^www\./, "").toLowerCase();
  const paths = new Set<string>(["/"]);
  if (urlsFetch.ok) {
    for (const u of urlsFetch.urls) {
      try {
        const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
        if (parsed.hostname.replace(/^www\./, "").toLowerCase() === host) paths.add(parsed.pathname || "/");
      } catch { /* пропускаем кривой URL */ }
      if (paths.size >= cap) break;
    }
  }

  await fs.mkdir(diskDir, { recursive: true });
  const stats = { archiveRefsRewritten: 0, externalLinksStripped: 0, trackersRemoved: 0, jsLinksStripped: 0, foreignAssetsStripped: 0 };
  const failed: { path: string; reason: string }[] = [];
  const pages: RestoreResult["pages"] = [];
  let restored = 0;
  let assetsRestored = 0;
  let assetsFailed = 0;
  const assetSeen = new Set<string>();

  // Выкачка своих ассетов страницы. Вызывается и для свежескачанных страниц, и для уже лежащих
  // (возобновление): прошлый слайс мог упереться в дедлайн посреди ассетов страницы, а её файл
  // уже существовал бы — без этого повтора хвост ассетов оставался невыкачанным навсегда.
  // Существующие файлы пропускаются дешёвой проверкой, качаются только отсутствующие.
  const fetchAssets = async (html: string, pagePath: string): Promise<void> => {
    // Свои ассеты страницы: качаем из архива (im_) на диск, лимит на сайт. Не скачалось —
    // ссылка остаётся относительной (битая, но НЕ хотлинк и НЕ выдуманная заглушка).
    for (const rel of collectSameOriginAssets(html)) {
      if (assetSeen.size >= ASSET_CAP) break;
      let absPath: string;
      try { absPath = new URL(rel, `https://${host}${pagePath}`).pathname; } catch { continue; }
      if (assetSeen.has(absPath)) continue;
      assetSeen.add(absPath);
      const file = pageFilePath(diskDir, absPath);
      try { await fs.access(file); assetsRestored++; continue; } catch { /* нет — качаем */ }
      if (Date.now() > deadline) break;
      try {
        const res = await cdxGate(() => fetch(`https://web.archive.org/web/${snapshotTimestamp}im_/https://${host}${absPath}`, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 }));
        if (res.status >= 400) { assetsFailed++; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
        assetsRestored++;
      } catch { assetsFailed++; }
    }
  };

  const pathList = [...paths];
  let processed = 0;
  for (const p of pathList) {
    const file0 = pageFilePath(diskDir, p);
    try {
      // Уже скачано на прошлом проходе — засчитываем и идём дальше (возобновляемость).
      await fs.access(file0);
      restored++; processed++;
      const existing = await fs.readFile(file0, "utf8").catch(() => "");
      if (existing) {
        const t0 = pageText(existing);
        const b0 = findTextBlocks(existing).map(b => ({ tag: b.tag, textLength: b.textLength }));
        pages.push({ path: p, title: extractTitle(existing) || undefined, textChars: t0.length, blocks: b0, status: b0.length ? "ok" : "needs_paragraph" });
        // Ассеты этой страницы могли оборваться на дедлайне прошлого слайса — добираем.
        await fetchAssets(existing, p);
        if (Date.now() > deadline) break;
      }
      continue;
    } catch { /* файла нет — качаем ниже */ }
    if (Date.now() > deadline) break; // слайс истёк — остальное доберёт следующий вызов
    processed++;
    const snapUrl = `https://web.archive.org/web/${snapshotTimestamp}id_/https://${host}${p}`;
    let html = "";
    try {
      const res = await cdxGate(() => fetch(snapUrl, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 }));
      if (res.status >= 400) { failed.push({ path: p, reason: `http_${res.status}` }); continue; }
      html = await res.text();
    } catch {
      failed.push({ path: p, reason: "fetch_failed" });
      continue;
    }
    if (!html.trim()) { failed.push({ path: p, reason: "empty" }); continue; }

    const cleaned = cleanHtml(html, { domain: host });
    stats.archiveRefsRewritten += cleaned.stats.archiveRefsRewritten;
    stats.externalLinksStripped += cleaned.stats.externalLinksStripped;
    stats.trackersRemoved += cleaned.stats.trackersRemoved;
    stats.jsLinksStripped += cleaned.stats.jsLinksStripped;
    stats.foreignAssetsStripped += cleaned.stats.foreignAssetsStripped;

    const file = pageFilePath(diskDir, p);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, cleaned.html, "utf8");
    restored++;

    const text = pageText(cleaned.html);
    const blocks = findTextBlocks(cleaned.html).map(b => ({ tag: b.tag, textLength: b.textLength }));
    pages.push({
      path: p, title: extractTitle(cleaned.html) || undefined, textChars: text.length,
      blocks, status: blocks.length ? "ok" : "needs_paragraph",
    });

    await fetchAssets(cleaned.html, p);
  }

  const remaining = Math.max(0, pathList.length - processed);
  return { pagesRequested: paths.size, pagesRestored: restored, remaining, done: remaining === 0, assetsRestored, assetsFailed, pagesFailed: failed, cleanedStats: stats, pages };
}

// ─── Применение кампании ссылок ──────────────────────────────────────────────

export type GenerateSurrounding = (pageText: string, anchor: string, lang?: string) => Promise<string | undefined>;

export interface CampaignSite {
  siteId: string;
  domain: string;
  diskDir: string;
}

export interface AppliedLink {
  siteId: string;
  pagePath: string;
  anchorText: string;
  anchorKind: string;
  targetUrl: string;
  rel: string;
  placement: "content" | "nav" | "footer";
  surroundingText?: string;
  status: "placed" | "skipped";
  skipReason?: string;
}


/**
 * Применить кампанию: анкоры по долям (planAnchors), rel по долям (planRel), на главной каждого
 * сайта — контекстная ссылка в найденный блок; нет блока → LLM-абзац. ДИСК НЕ ПИШЕТСЯ: ссылки
 * хранятся декларативно в PbnLink, а в файл запекаются только при отдаче (renderPage) — поэтому
 * повторное применение не плодит дублей, а смена анкора/таргета не требует перезаливки.
 */
export async function applyCampaignToSites(
  sites: CampaignSite[],
  anchors: AnchorSpec[],
  shares: AnchorShares,
  targetUrl: string,
  relShares: Partial<Record<Rel, number>>,
  seed: number,
  generate?: GenerateSurrounding,
): Promise<AppliedLink[]> {
  const plan = planAnchors(anchors, shares, sites.length, seed);
  const rels = planRel(relShares, sites.length, seed);
  const out: AppliedLink[] = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const anchor = plan.assignments[i];
    const rel = rels[i] ?? "dofollow";
    const base = { siteId: site.siteId, pagePath: "/", targetUrl, rel };
    if (!anchor) { out.push({ ...base, anchorText: "", anchorKind: "generic", placement: "content", status: "skipped", skipReason: "no_anchor" }); continue; }
    const row = { ...base, anchorText: anchor.text, anchorKind: anchor.kind };

    let html = "";
    try { html = await fs.readFile(path.join(site.diskDir, "index.html"), "utf8"); }
    catch { out.push({ ...row, placement: "content", status: "skipped", skipReason: "no_index_file" }); continue; }

    const choice = choosePlacement(html, anchor.text);
    if (choice.needsParagraph || !choice.block) {
      if (!generate) { out.push({ ...row, placement: "content", status: "skipped", skipReason: "no_content_block" }); continue; }
      const surrounding = await generate(pageText(html), anchor.text, extractHtmlLang(html));
      if (!surrounding || !surrounding.includes("{link}")) { out.push({ ...row, placement: "content", status: "skipped", skipReason: "no_paragraph_generated" }); continue; }
      out.push({ ...row, placement: "footer", surroundingText: surrounding, status: "placed" });  // footer = appended generated paragraph
      continue;
    }
    const surrounding = generate ? await generate(choice.block.text, anchor.text, extractHtmlLang(html)) : undefined;
    out.push({ ...row, placement: "content", surroundingText: surrounding, status: "placed" });
  }
  return out;
}

