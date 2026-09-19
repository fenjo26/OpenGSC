/**
 * Вебархив: построение запроса и разбор ответа. Сети здесь нет —
 * фетчинг живёт в стадии, как и в остальном конвейере /drops.
 */

export interface CdxRow {
  timestamp: string;
  original: string;
  statuscode: string;
  mimetype?: string;
  digest?: string;
  length?: number;
}

export interface CdxQueryOptions {
  /** сколько последних снимков взять (отрицательный limit в API) */
  last?: number;
  /** схлопывать по префиксу метки времени: 4 — по году, 6 — по месяцу */
  collapseTimestamp?: 4 | 6;
  from?: string;
  to?: string;
}

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";

/**
 * Важные детали, на которых обычно ошибаются:
 *  - limit отрицательный, иначе вернутся ПЕРВЫЕ снимки (2009 год) вместо последних;
 *  - фильтр по statuscode выбрасывает revisit-записи, у которых статус приходит "-",
 *    поэтому фильтруем мягко и отсекаем уже на разборе;
 *  - collapse=digest схлопывает только ПОДРЯД идущие одинаковые копии.
 */
export function buildCdxUrl(domain: string, opts: CdxQueryOptions = {}): string {
  const params = new URLSearchParams({
    url: domain,
    output: "json",
    fl: "timestamp,original,statuscode,mimetype,digest,length",
    filter: "mimetype:text/html",
    collapse: opts.collapseTimestamp ? `timestamp:${opts.collapseTimestamp}` : "digest",
    limit: String(-(opts.last ?? 3)),
    fastLatest: "true",
  });
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

/** Оригинальные байты снимка, без тулбара архива и без переписанных ссылок. */
export function rawSnapshotUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${original}`;
}

/**
 * Первая строка ответа CDX — заголовки колонок. Строки с неизвестным статусом
 * ("-", пусто) сохраняются: это revisit-записи, они значат, что страница не менялась.
 */
export function parseCdxJson(body: unknown): CdxRow[] {
  if (!Array.isArray(body) || body.length < 2) return [];
  const [header, ...rest] = body as string[][];
  if (!Array.isArray(header)) return [];
  const idx = (name: string) => header.indexOf(name);
  const iTs = idx("timestamp");
  const iOrig = idx("original");
  const iStatus = idx("statuscode");
  if (iTs < 0 || iOrig < 0) return [];

  const rows: CdxRow[] = [];
  for (const row of rest) {
    if (!Array.isArray(row) || !row[iTs]) continue;
    rows.push({
      timestamp: String(row[iTs]),
      original: String(row[iOrig] ?? ""),
      statuscode: String(row[iStatus] ?? "-"),
      mimetype: at(row, idx("mimetype")),
      digest: at(row, idx("digest")),
      length: numberAt(row, idx("length")),
    });
  }
  return rows;
}

/** Снимки, годные для чтения содержимого: не 4xx/5xx. */
export function usableRows(rows: CdxRow[]): CdxRow[] {
  return rows.filter((r) => {
    const code = Number(r.statuscode);
    if (Number.isNaN(code)) return true; // revisit — содержимое есть
    return code < 400;
  });
}

/* ------------------------------------------------------------------ */
/* Чтение снимка                                                       */
/* ------------------------------------------------------------------ */

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html);
  return m ? decodeEntities(collapse(stripTags(m[1]))) : "";
}

/** Немного текста со страницы: усиливает вердикт там, где титул пустой. */
export function extractTextSample(html: string, maxChars = 1200): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = collapse(
    decodeEntities(
      stripTags(
        body
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<!--[\s\S]*?-->/g, " "),
      ),
    ),
  );
  return text.slice(0, maxChars);
}

export function extractHtmlLang(html: string): string | undefined {
  const tag = /<html\b[^>]*>/i.exec(html)?.[0];
  if (!tag) return undefined;
  return /\blang\s*=\s*["']?([a-z-]+)/i.exec(tag)?.[1];
}

/** meta refresh и JS-редирект: в снимках паркинга встречаются постоянно. */
export function extractMetaRefresh(html: string, base: string): string | undefined {
  const tag = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/i.exec(html)?.[0];
  const url = tag ? /url\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1] : undefined;
  if (!url) return undefined;
  try {
    return new URL(url, base).toString();
  } catch {
    return undefined;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

function collapse(s: string): string {
  return s.replace(/[\s\u00a0]+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)));
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function at(row: string[], i: number): string | undefined {
  return i >= 0 && row[i] !== undefined ? String(row[i]) : undefined;
}

function numberAt(row: string[], i: number): number | undefined {
  const v = at(row, i);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
