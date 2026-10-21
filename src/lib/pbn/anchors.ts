// Распределение анкоров по сетке восстановленных дропов.
//
// Чем это отличается от WayForge. У них анкор дропа i — это `anchors[i % n]`: голая ротация
// по кругу. Нельзя сказать «10% точных анкоров, 40% брендовых, 50% URL» — доля каждого типа не
// задаётся, порядок на сетке регулярный (дроп 1 → анкор 1, дроп 2 → анкор 2…), и это сам по
// себе отпечаток. Здесь анкор-лист разбит по ТИПАМ с долями, раскладка детерминирована от seed
// (одна и та же кампания раскладывается одинаково при каждом пересчёте — важно для превью и для
// повторного применения), а порядок перемешан, а не идёт подряд.
//
// Сети здесь нет, базы нет: чистая функция, тест рядом.

export type AnchorKind = "exact" | "brand" | "url" | "generic";

export const ANCHOR_KINDS: readonly AnchorKind[] = ["exact", "brand", "url", "generic"];

/** Один анкор в списке кампании: текст + его тип. */
export interface AnchorSpec {
  text: string;
  kind: AnchorKind;
}

/** Доли типов анкоров, в произвольных единицах (нормализуются сами). Отсутствующий тип = 0. */
export type AnchorShares = Partial<Record<AnchorKind, number>>;

export interface AnchorPlan {
  /** Индекс дропа в сетке → назначенный анкор. Длина = числу дропов. */
  assignments: AnchorSpec[];
  /** Сколько анкоров каждого типа реально роздано (для отчёта в UI). */
  byKind: Record<AnchorKind, number>;
}

/**
 * Детерминированный ГПСЧ (mulberry32) от числового seed. Нужен, чтобы «перемешать, но
 * воспроизводимо»: Math.random() дал бы разную раскладку в превью и при применении.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Строковый seed (id кампании) → 32-битное число. FNV-1a. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Разложить анкоры по `count` дропам согласно долям типов.
 *
 * Правила, которых нет у WayForge:
 *  - Квоты считаются по долям (`largest remainder`), а не по кругу: при 10 дропах и долях
 *    exact:1 / url:4 выйдет 2 exact и 8 url, а не чередование.
 *  - Внутри типа конкретный текст берётся по кругу (если текстов в типе меньше, чем квота) —
 *    но какие дропы какому типу достанутся, перемешано детерминированно от seed.
 *  - Тип без анкоров в списке получает квоту 0, даже если доля задана: нельзя раздать то,
 *    чего нет. Остаток уходит следующему по величине доли типу.
 *  - Если анкоров нет вовсе — пустой план (вызывающий решает, что делать; мы не подставляем
 *    голый домен, как WayForge, — это их отпечаток).
 */
export function planAnchors(
  anchors: AnchorSpec[],
  shares: AnchorShares,
  count: number,
  seed: number,
): AnchorPlan {
  const empty: Record<AnchorKind, number> = { exact: 0, brand: 0, url: 0, generic: 0 };
  if (count <= 0 || anchors.length === 0) {
    return { assignments: [], byKind: { ...empty } };
  }

  // Анкоры по типам, пустые типы отбрасываем.
  const byKindList = new Map<AnchorKind, AnchorSpec[]>();
  for (const a of anchors) {
    const text = a.text.trim();
    if (!text) continue;
    const list = byKindList.get(a.kind) ?? [];
    list.push({ text, kind: a.kind });
    byKindList.set(a.kind, list);
  }
  const available = ANCHOR_KINDS.filter(k => (byKindList.get(k)?.length ?? 0) > 0);
  if (available.length === 0) return { assignments: [], byKind: { ...empty } };

  // Нормализуем доли только по типам, для которых есть анкоры. Тип с долей, но без текстов,
  // своей квоты не получает — она перераспределяется между доступными.
  const weights = available.map(k => Math.max(0, shares[k] ?? 0));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  // Если доли не заданы вовсе — поровну между доступными типами.
  const normWeights = totalWeight > 0 ? weights : available.map(() => 1);
  const normTotal = normWeights.reduce((s, w) => s + w, 0);

  // Квоты методом наибольшего остатка: сумма квот точно равна count.
  const raw = normWeights.map(w => (w / normTotal) * count);
  const quota = raw.map(Math.floor);
  let assigned = quota.reduce((s, q) => s + q, 0);
  const remainders = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let r = 0; assigned < count; r++, assigned++) {
    quota[remainders[r % remainders.length].i] += 1;
  }

  // Плоский список назначений по типам, затем детерминированное перемешивание позиций.
  const byKind: Record<AnchorKind, number> = { ...empty };
  const pool: AnchorSpec[] = [];
  available.forEach((kind, qi) => {
    const texts = byKindList.get(kind)!;
    const n = quota[qi];
    byKind[kind] = n;
    for (let j = 0; j < n; j++) pool.push(texts[j % texts.length]);
  });

  // Fisher–Yates с seeded ГПСЧ: раскладка воспроизводима, но не регулярна.
  const rng = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return { assignments: pool.slice(0, count), byKind };
}
