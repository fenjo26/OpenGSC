/**
 * Shared vocabulary for Backlinks v2 — see `docs/tasks/CONTRACT.md` §2.
 *
 * Types only, and no import from Prisma on purpose: client components import this file too, and
 * pulling the generated client into a `"use client"` bundle drags the query engine along with it.
 * The Prisma models in `prisma/schema.prisma` are the storage shape; these are the wire and UI
 * shape, and they are allowed to differ (dates arrive as ISO strings, `sources` arrives split).
 */

export type PlacementStatus = "unchecked" | "found" | "missing" | "blocked" | "error";
export type PageStatus = "unknown" | "alive" | "dead" | "blocked";
export type BacklinkSource = "api" | "csv" | "manual";
export type BacklinkEventKind =
  | "appeared" | "lost" | "returned"
  | "rel_downgraded" | "rel_upgraded"
  | "anchor_changed" | "target_changed";

/** Разобранный атрибут rel. Булев "nofollow" недостаточен: sponsored и ugc
 *  тоже не передают вес, но nofollow при этом может отсутствовать. */
export interface RelFlags {
  raw: string;
  nofollow: boolean;
  sponsored: boolean;
  ugc: boolean;
  /** true, когда не выставлен ни один из трёх — то есть ссылка реально передаёт вес */
  dofollow: boolean;
}

/** Одна ссылка, найденная на странице-доноре. */
export interface PlacementHit {
  /** URL донора ровно как его передали на вход (для джойна с таблицей клиента) */
  sourceUrl: string;
  /** URL страницы, которая фактически ответила (после редиректов) */
  finalUrl: string;
  /** какой из наших доменов совпал */
  matchedDomain: string;
  /** абсолютный URL ссылки */
  linkUrl: string;
  /** анкор; для картиночных ссылок — alt; схлопнутые пробелы, максимум 200 символов */
  anchor: string;
  isImage: boolean;
  rel: RelFlags;
}

/** Результат сканирования одной страницы. */
export interface PlacementScan {
  sourceUrl: string;
  finalUrl: string;
  status: PlacementStatus;
  pageStatus: PageStatus;
  httpStatus: number;
  /** пусто при status !== "error" */
  error: string;
  /** страница взята с отключённой проверкой сертификата */
  insecure: boolean;
  hits: PlacementHit[];
}

/** Строка, как её отдаёт API интерфейсу. */
export interface BacklinkRow {
  id: string;
  urlFrom: string;
  urlTo: string;
  domainFrom: string;
  favorite: boolean;
  source: BacklinkSource;
  sources: string[];

  apiSeen: boolean;
  apiLost: boolean;
  apiAnchor: string;
  apiDr: number | null;
  apiDofollow: boolean;
  apiSponsored: boolean;
  apiUgc: boolean;
  apiContent: boolean;
  apiJsCrawl: boolean;
  apiFirstSeen: string;

  checkStatus: PlacementStatus;
  checkAnchor: string;
  checkRel: string;
  checkNofollow: boolean;
  checkSponsored: boolean;
  checkUgc: boolean;
  checkTargetOk: boolean | null;
  checkError: string;
  checkedAt: string | null;

  pageStatus: PageStatus;
  pageTitle: string;
  xrStatus: string;
  addedAt: string;
}

export interface BacklinkListStats {
  total: number;
  found: number;
  missing: number;
  blocked: number;
  unchecked: number;
  apiLost: number;
  favorites: number;
  nofollow: number;
}

export interface BacklinkListResponse {
  rows: BacklinkRow[];
  total: number;
  page: number;      // 1-based
  pageSize: number;
  stats: BacklinkListStats;   // по всей выборке с учётом фильтров, не по странице
}

/** Итог одного прогона — и для выгрузки, и для проверки. Формат общий,
 *  потому что дайджест и UI читают его одинаково. */
export interface SyncSummary {
  scanned: number;
  withLink: number;
  zeroMatches: number;
  errors: number;
  blocked: number;
  byDomain: Record<string, number>;
  byError: Record<string, number>;
  unitsSpent: number;
  complete: boolean;
}
