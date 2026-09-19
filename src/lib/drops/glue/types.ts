/**
 * Склейка дропа с мани-доменом через hreflang/canonical.
 *
 * Два режима:
 *  - "cluster" — то, что документирует Google: каждая страница канонична сама себе,
 *    hreflang взаимный, x-default один. Не сливает сигналы, но и не отлетает.
 *  - "funnel"  — наблюдаемая в выдаче схема: все канониклы указывают на дроп,
 *    hreflang подставляет URL мани-домена под локаль. Сигналы сливаются в дроп.
 *    Это намеренное нарушение рекомендации "hreflang должен указывать на канонические URL",
 *    поэтому валидатор понижает соответствующие проверки до info именно в этом режиме.
 */

export type GlueMode = "cluster" | "funnel";

export type Severity = "blocker" | "warn" | "info";

export interface GlueAlternate {
  /** значение hreflang, например "en-GB" или "el-GR" */
  hreflang: string;
  /** абсолютный URL страницы этой локали */
  url: string;
}

export interface GlueSpec {
  mode: GlueMode;
  /** дроп: якорь канoникала в режиме funnel и цель x-default по умолчанию */
  dropUrl: string;
  /** язык для <html lang> на самом дропе; по умолчанию базовый субтег первой локали */
  dropHtmlLang?: string;
  /** страницы мани-домена по локалям */
  alternates: GlueAlternate[];
  /** цель x-default; по умолчанию dropUrl */
  xDefault?: string;
}

export interface GluePage {
  role: "drop" | "money";
  /** URL самой страницы (нормализованный) */
  url: string;
  /** значение атрибута <html lang="..."> */
  htmlLang: string;
  /** цель rel=canonical */
  canonical: string;
  /** полный набор alternate-аннотаций, одинаковый на всех страницах кластера */
  alternates: GlueAlternate[];
  xDefault: string;
  /** готовый блок для вставки в <head> */
  head: string;
}

export interface GluePlan {
  mode: GlueMode;
  pages: GluePage[];
  /** замечания генератора: исправленные коды локалей, подставленные значения и т.п. */
  notes: GlueNote[];
}

export interface GlueNote {
  code: string;
  severity: Severity;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* Валидатор                                                           */
/* ------------------------------------------------------------------ */

/** То, что отдаёт фетчер (safeFetch + ручная обработка редиректов) */
export interface PageFetch {
  requestedUrl: string;
  /** URL после всех редиректов */
  finalUrl: string;
  /** HTTP-статус финального ответа; 0 — сеть не ответила */
  status: number;
  /** цепочка редиректов, без финального ответа */
  redirectChain?: { url: string; status: number }[];
  /** заголовки финального ответа в нижнем регистре */
  headers?: Record<string, string>;
  /** HTML финального ответа; может отсутствовать при ошибке */
  html?: string;
  /** текст ошибки, если запрос не состоялся */
  error?: string;
}

/** Разобранные факты о странице — без сети, чисто из HTML и заголовков */
export interface PageFacts {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: { url: string; status: number }[];
  htmlLang: string | null;
  canonical: string | null;
  /** canonical как он написан в разметке, до абсолютизации */
  canonicalRaw: string | null;
  alternates: GlueAlternate[];
  /** alternate-ы как написаны, до абсолютизации */
  alternatesRaw: { hreflang: string; url: string }[];
  /** директивы из <meta name="robots"> и X-Robots-Tag, в нижнем регистре */
  robots: string[];
  error?: string;
}

export interface Finding {
  code: string;
  severity: Severity;
  /** страница, к которой относится находка */
  page: string;
  detail?: string;
}

export interface GlueReport {
  mode: GlueMode;
  ok: boolean;
  findings: Finding[];
  /** сводка по severity */
  counts: Record<Severity, number>;
}
