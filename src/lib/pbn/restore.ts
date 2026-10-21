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
import { findTextBlocks, choosePlacement, buildAnchorTag, injectIntoBlock, type Rel } from "./place";
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

/** Относительный путь страницы → имя файла на диске. "/" → index.html, "/a/b" → a/b/index.html */
function pageFilePath(root: string, urlPath: string): string {
  let p = urlPath.split("?")[0].split("#")[0];
  if (!p || p === "/") return path.join(root, "index.html");
  p = p.replace(/^\/+/, "");
  if (p.endsWith("/")) p += "index.html";
  else if (!/\.[a-z0-9]{1,6}$/i.test(p)) p += "/index.html";
  // защита от выхода за корень
  const full = path.normalize(path.join(root, p));
  return full.startsWith(root) ? full : path.join(root, "index.html");
}

export interface RestoreResult {
  pagesRequested: number;
  pagesRestored: number;
  remaining: number;
  done: boolean;
  pagesFailed: { path: string; reason: string }[];
  cleanedStats: { archiveRefsRewritten: number; externalLinksStripped: number; trackersRemoved: number; jsLinksStripped: number };
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
  const stats = { archiveRefsRewritten: 0, externalLinksStripped: 0, trackersRemoved: 0, jsLinksStripped: 0 };
  const failed: { path: string; reason: string }[] = [];
  const pages: RestoreResult["pages"] = [];
  let restored = 0;

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
  }

  const remaining = Math.max(0, pathList.length - processed);
  return { pagesRequested: paths.size, pagesRestored: restored, remaining, done: remaining === 0, pagesFailed: failed, cleanedStats: stats, pages };
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

function pickRel(relShares: Partial<Record<Rel, number>>, i: number): Rel {
  const kinds: Rel[] = ["dofollow", "nofollow", "sponsored"];
  const weights = kinds.map(k => Math.max(0, relShares[k] ?? (k === "dofollow" ? 1 : 0)));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  // детерминированно по позиции: порог по накопленной доле
  const pos = ((i + 0.5) / Math.max(1, total)) % 1;
  let acc = 0;
  for (let k = 0; k < kinds.length; k++) { acc += weights[k] / total; if (pos <= acc) return kinds[k]; }
  return "dofollow";
}

/**
 * Применить кампанию к набору сайтов: анкоры по долям (planAnchors), на главной каждого сайта —
 * контекстная ссылка в найденный блок; нет блока → LLM-абзац (если дан генератор). Пишем файл
 * на диск (главную) и возвращаем список размещений для записи PbnLink. Сквозные и внутренние
 * страницы — следующий слой; здесь базовый путь «морда».
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
  const out: AppliedLink[] = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const anchor = plan.assignments[i];
    const rel = pickRel(relShares, i);
    if (!anchor) { out.push({ siteId: site.siteId, pagePath: "/", anchorText: "", anchorKind: "generic", targetUrl, rel, placement: "content", status: "skipped", skipReason: "no_anchor" }); continue; }

    const indexFile = path.join(site.diskDir, "index.html");
    let html = "";
    try { html = await fs.readFile(indexFile, "utf8"); }
    catch { out.push({ siteId: site.siteId, pagePath: "/", anchorText: anchor.text, anchorKind: anchor.kind, targetUrl, rel, placement: "content", status: "skipped", skipReason: "no_index_file" }); continue; }

    const choice = choosePlacement(html, anchor.text);
    const tag = buildAnchorTag(targetUrl, anchor.text, rel);

    if (choice.needsParagraph || !choice.block) {
      // Нет подходящего блока. Генерируем абзац под тему страницы, если дан генератор; иначе —
      // честный skip, НЕ дамп в начало body.
      if (!generate) { out.push({ siteId: site.siteId, pagePath: "/", anchorText: anchor.text, anchorKind: anchor.kind, targetUrl, rel, placement: "content", status: "skipped", skipReason: "no_content_block" }); continue; }
      const surrounding = await generate(pageText(html), anchor.text, extractHtmlLang(html));
      if (!surrounding || !surrounding.includes("{link}")) { out.push({ siteId: site.siteId, pagePath: "/", anchorText: anchor.text, anchorKind: anchor.kind, targetUrl, rel, placement: "content", status: "skipped", skipReason: "no_paragraph_generated" }); continue; }
      // Вставляем абзац перед </body>, но это сгенерированный текст, не голый анкор.
      const para = `<p>${surrounding.replace("{link}", tag)}</p>`;
      const body = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${para}</body>`) : html + para;
      await fs.writeFile(indexFile, body, "utf8");
      out.push({ siteId: site.siteId, pagePath: "/", anchorText: anchor.text, anchorKind: anchor.kind, targetUrl, rel, placement: "content", surroundingText: surrounding, status: "placed" });
      continue;
    }

    const surrounding = generate ? await generate(choice.block.text, anchor.text, extractHtmlLang(html)) : undefined;
    const injected = injectIntoBlock(html, choice.block, tag, surrounding);
    await fs.writeFile(indexFile, injected, "utf8");
    out.push({ siteId: site.siteId, pagePath: "/", anchorText: anchor.text, anchorKind: anchor.kind, targetUrl, rel, placement: "content", surroundingText: surrounding, status: "placed" });
  }
  return out;
}
