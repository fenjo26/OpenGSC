/**
 * Проверка «токсичности» дропа по истории главной страницы.
 *
 * Задача стадии: отсеять домены, которые уже отработали под чужой схемой
 * (китайский/индонезийский гембл, взрослое, фарма, реплики) или никогда
 * ничем не были — ДО платных обогащений и до покупки.
 *
 * Два принципиальных отличия от наивной реализации «доля иероглифов в титуле»:
 *
 *  1. Считается АБСОЛЮТНОЕ присутствие чужой письменности, а не её доля.
 *     Титул `mile米乐·m6(中国区)官方网站` — это китайское казино, хотя латиницы
 *     в нём почти половина и любой порог по доле его пропустит.
 *  2. Письменность и тематика — разные сигналы. Китайский сайт сам по себе
 *     не «токсичен»; токсична связка «чужая для зоны письменность» +
 *     «маркеры гембла/адалта», либо смена языка между снапшотами (флип).
 */

export type ToxVerdict = "clean" | "empty" | "suspicious" | "toxic";

export type ScriptName = "latin" | "cyrillic" | "cjk" | "hangul" | "thai" | "arabic" | "hebrew" | "devanagari";

/** Один снимок главной страницы (из вебархива, Common Crawl или живого фетча). */
export interface Snapshot {
  /** метка времени CDX: YYYYMMDDhhmmss */
  timestamp: string;
  status?: number;
  title?: string;
  /** фрагмент текста страницы, если есть — повышает точность */
  text?: string;
  /** значение <html lang> */
  htmlLang?: string;
  /** куда редиректил снимок, если редиректил */
  redirectTo?: string;
}

export interface DomainEvidence {
  domain: string;
  snapshots: Snapshot[];
  /**
   * Анкоры входящих ссылок, если уже загружены (DropCandidate.topAnchors).
   * Бесплатный и сильный сигнал: вебархив мог не заснять момент флипа,
   * а анкоры доноров переживают смену контента на самом домене.
   */
  anchors?: string[];
  /** сегодняшняя дата для оценки свежести; по умолчанию Date.now() */
  now?: Date;
}

export interface ToxSignal {
  code: string;
  /** вклад в счёт до поправки на свежесть */
  weight: number;
  detail: string;
  /** снимок, в котором найдено */
  timestamp?: string;
}

export interface SnapshotVerdict {
  timestamp: string;
  scripts: ScriptName[];
  parked: boolean;
  signals: ToxSignal[];
}

export interface ToxReport {
  domain: string;
  verdict: ToxVerdict;
  /** 0..100+, сумма взвешенных сигналов */
  score: number;
  signals: ToxSignal[];
  perSnapshot: SnapshotVerdict[];
  /** true, если ни в одном снимке не было содержательной страницы */
  neverUsed: boolean;
}

export interface ToxOptions {
  /** порог "токсичен" (по умолчанию 60) */
  toxicAt?: number;
  /** порог "подозрителен" (по умолчанию 25) */
  suspiciousAt?: number;
  now?: Date;
}
