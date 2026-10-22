// Оценка снимка Вебархива для восстановления под PBN.
//
// Чем это отличается от WayForge (проверено на их живом /api/prescan):
//  1. Для доменов, которых нет в архиве (CDX пуст / все 404), они ВЫДУМЫВАЮТ снимок: score 97,
//     "recommended", 5 страниц /about.html /faq.html…, один timestamp на всех. Здесь пустой ввод
//     даёт verdict "no_snapshot" и score 0 — врать нельзя.
//  2. Их score растёт за объём медиа и CSS: 2-страничный снимок 2016 (уже редирект на чужой
//     бренд) они оценили выше 32-страничного. Здесь вес на КОНТЕНТЕ — число страниц с текстом и
//     длина текста, а чужой бренд в <title> после смены владельца снижает оценку.
//
// Чистая функция: на вход — уже собранные метрики снимка (кто их собрал — дело стадии, как в
// toxicity/collect.ts), на выход — вердикт и 0..100.

export type SnapshotVerdict =
  | "recommended"        // годен: есть контент на нескольких страницах, бренд свой
  | "thin"               // мало текста/страниц — ссылке негде встать красиво
  | "brand_mismatch"     // в <title> чужой бренд — домен сменил владельца/редиректил на бренд
  | "parked_or_doorway"  // заглушка/паркинг/дорвей
  | "no_snapshot";       // снимка нет вовсе — НЕ выдумываем

export interface SnapshotMetrics {
  timestamp: string;              // YYYYMMDDhhmmss
  /** Число страниц снимка, у которых есть текстовый контент (а не только навигация/картинки). */
  pagesWithText: number;
  /** Суммарная длина видимого текста по этим страницам, символов. */
  textChars: number;
  /** <title> главной, если есть. */
  title?: string;
  /** Домен, под который восстанавливаем (для сверки с брендом в title). */
  domain: string;
  /** Снимок редиректит (meta refresh / JS) — частый признак паркинга. */
  redirects?: boolean;
  /** Явные маркеры паркинга в тексте (sedo, "domain is for sale", "coming soon"...). */
  parkingSignals?: boolean;
}

export interface SnapshotScore {
  verdict: SnapshotVerdict;
  score: number;        // 0..100
  reason: string;       // одна фраза, фактическая, без рекомендаций
}

const MIN_TEXT_FOR_LINK = 1200;   // меньше — контекстной ссылке негде встать (урок pets.com: 950 симв. = только навигация)
const GOOD_TEXT = 6000;          // насыщение шкалы текста
const GOOD_PAGES = 8;            // насыщение шкалы страниц

/** "petsmart" из "PETsMART.com - The smarter way…"; домен "pets.com" → "pets". */
function brandToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0] ?? "";
}

/**
 * Чужой бренд в title. Ловит случай, когда домен сменил владельца и архив показывает чужой
 * сайт (pets.com → "PETsMART…"). Подстрока не годится — "pets" входит в "petsmart", — поэтому
 * сверяем ПО ТОКЕНАМ заголовка: домен-метка должна встречаться отдельным словом или складываться
 * из первых слов (bestpetshop.com → "Best Pet Shop" = свой). Иначе первое слово заголовка —
 * чужой бренд.
 */
function brandMismatch(title: string | undefined, domain: string): boolean {
  if (!title) return false;
  const host = domain.toLowerCase().replace(/^www\./, "").split(".")[0];
  const brand = brandToken(title);
  if (brand.length < 4) return false;
  const generic = new Set(["home", "welcome", "index", "untitled", "page", "default", "coming", "the", "site"]);
  if (generic.has(brand)) return false;

  const tokens = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (tokens.includes(host)) return false;        // домен — отдельное слово заголовка
  let acc = "";
  for (const t of tokens) {                        // или складывается из первых слов
    acc += t;
    if (acc === host) return false;
    if (acc.length > host.length) break;
  }
  return true;
}

export function scoreSnapshot(m: SnapshotMetrics): SnapshotScore {
  if (m.parkingSignals || m.redirects) {
    return { verdict: "parked_or_doorway", score: 8, reason: m.parkingSignals ? "parking/sale/placeholder text" : "snapshot redirects away" };
  }
  if (m.pagesWithText <= 0 || m.textChars <= 0) {
    return { verdict: "thin", score: 10, reason: "no readable page content in the snapshot" };
  }
  if (brandMismatch(m.title, m.domain)) {
    // Чужой бренд — восстанавливать опасно (это уже чей-то товарный знак), но скрывать не
    // будем: отдельный вердикт, низкий score, оператор решает сам.
    return { verdict: "brand_mismatch", score: 25, reason: `title names another brand: "${(m.title ?? "").slice(0, 48)}"` };
  }

  const textScore = Math.min(1, m.textChars / GOOD_TEXT);
  const pageScore = Math.min(1, m.pagesWithText / GOOD_PAGES);
  // Контент решает: текст весит больше числа страниц (одна насыщенная страница лучше десяти
  // пустых разделов — обратное тому, как считает WayForge).
  const score = Math.round((textScore * 0.65 + pageScore * 0.35) * 100);

  if (m.textChars < MIN_TEXT_FOR_LINK) {
    return { verdict: "thin", score: Math.min(score, 35), reason: `only ${m.textChars} chars of text — no room for an in-content link` };
  }
  return {
    verdict: "recommended",
    score: Math.max(50, score),
    reason: `${m.pagesWithText} page(s) with text, ${m.textChars} chars`,
  };
}

/** Из набора снимков выбрать лучший по score; пустой набор → honest no_snapshot. */
export function pickBestSnapshot(snapshots: SnapshotMetrics[]): (SnapshotScore & { timestamp: string }) | { verdict: "no_snapshot"; score: 0; reason: string } {
  if (snapshots.length === 0) {
    return { verdict: "no_snapshot", score: 0, reason: "no archived snapshot found for this domain" };
  }
  let best: (SnapshotScore & { timestamp: string }) | null = null;
  for (const m of snapshots) {
    const s = { ...scoreSnapshot(m), timestamp: m.timestamp };
    if (!best || s.score > best.score) best = s;
  }
  return best!;
}
