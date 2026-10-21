// Поиск мест под ссылку в восстановленном HTML — и вставка без футпринта.
//
// Почему не как у WayForge (проверено на их выдаче pets.com, табличная вёрстка 2004 года):
// их инжектор «первый абзац» не нашёл <p> и молча прилепил <div><p>голый анкор</p></div> в
// самое начало <body>, выше всего сайта; «футер» — туда же. Плюс каждая ссылка помечена
// data-wf-injected и одинаковым inline-стилем. Здесь:
//  - место ищется по СОДЕРЖИМОМУ: любой блок (p, td, div, li) с текстом ≥ порога — табличная
//    вёрстка тоже подходит, не только <p>;
//  - если подходящего блока нет — это флаг needsParagraph, а не «вставить куда попало»;
//  - вставка идёт БЕЗ атрибутов-маркеров и без своих классов/стилей (тест стережёт).
//
// Чистые функции над строкой HTML. Полноценный DOM — дело вызывающей стадии; здесь — разбор,
// которого хватает для снимков статичных сайтов, с которыми работает модуль.

export interface TextBlock {
  /** Тег блока: p | td | div | li. */
  tag: string;
  /** Индексы в исходной строке: [открывающий тег конец .. закрывающий тег начало). */
  innerStart: number;
  innerEnd: number;
  /** Длина видимого текста внутри. */
  textLength: number;
  /** Сам видимый текст (для тематической близости к анкору). */
  text: string;
}

const BLOCK_TAGS = ["p", "td", "div", "li"];
const MIN_BLOCK_TEXT = 150; // абзац, в который не стыдно встроить ссылку

function visibleText(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Найти текстовые блоки, годные под контекстную ссылку. Берём самые внутренние блоки (чтобы
 * не выбрать <div>, оборачивающий всю страницу): блок считается кандидатом, только если его
 * ВИДИМЫЙ текст не содержит ещё одного блок-тега — то есть это лист, а не контейнер.
 */
export function findTextBlocks(html: string, minText = MIN_BLOCK_TEXT): TextBlock[] {
  const blocks: TextBlock[] = [];
  const hasBlock = new RegExp(`<(${BLOCK_TAGS.join("|")})\\b`, "i");
  // По одному тегу за проход: иначе внешний <div> совпадает первым и съедает вложенные <p>/<td>
  // раньше, чем они дойдут до разбора. Лист-фильтр (нет блока внутри) отбрасывает контейнеры.
  for (const tag of BLOCK_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const inner = m[1];
      if (hasBlock.test(inner)) continue; // контейнер, а не лист
      const text = visibleText(inner);
      if (text.length < minText) continue;
      const innerStart = m.index + m[0].length - inner.length - (tag.length + 3); // минус "</tag>"
      blocks.push({ tag, innerStart, innerEnd: innerStart + inner.length, textLength: text.length, text });
    }
  }
  blocks.sort((a, b) => a.innerStart - b.innerStart);
  return blocks;
}

/** Грубая тематическая близость блока к анкору: доля слов анкора, встреченных в тексте блока. */
export function topicalScore(blockText: string, anchor: string): number {
  const words = anchor.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return 0;
  const hay = blockText.toLowerCase();
  const hits = words.filter(w => hay.includes(w)).length;
  return hits / words.length;
}

export interface PlacementChoice {
  /** Нашлось место в контенте? Если нет — нужен сгенерированный абзац. */
  needsParagraph: boolean;
  block?: TextBlock;
}

/** Выбрать блок под ссылку: самый тематически близкий к анкору, при равенстве — самый длинный. */
export function choosePlacement(html: string, anchor: string, minText = MIN_BLOCK_TEXT): PlacementChoice {
  const blocks = findTextBlocks(html, minText);
  if (!blocks.length) return { needsParagraph: true };
  let best = blocks[0];
  let bestScore = -1;
  for (const b of blocks) {
    const s = topicalScore(b.text, anchor) * 1000 + b.textLength;
    if (s > bestScore) { bestScore = s; best = b; }
  }
  return { needsParagraph: false, block: best };
}

export type Rel = "dofollow" | "nofollow" | "sponsored";

/** Тег <a> БЕЗ маркеров: только href и, при необходимости, rel. Никаких data-* и классов. */
export function buildAnchorTag(targetUrl: string, anchorText: string, rel: Rel): string {
  const raw = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
  const href = raw.replace(/&/g, "&amp;").replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  const relAttr = rel === "dofollow" ? "" : ` rel="${rel === "sponsored" ? "sponsored" : "nofollow"}"`;
  const safe = anchorText.replace(/[<>]/g, "");
  return `<a href="${href}"${relAttr}>${safe}</a>`;
}

/**
 * Вписать ссылку в существующее предложение блока: `surrounding` — это шаблон с {link}, который
 * LLM сгенерировала под тему страницы (или оператор ввёл). Мы НЕ навязываем «Partner: {link}».
 * Если шаблона нет — ссылка добавляется отдельным предложением в конец блока, одним тегом <a>.
 */
export function injectIntoBlock(
  html: string,
  block: TextBlock,
  anchorTag: string,
  surrounding?: string,
): string {
  const sentence = surrounding && surrounding.includes("{link}")
    ? surrounding.replace("{link}", anchorTag)
    : anchorTag;
  const addition = surrounding ? ` ${sentence}` : ` ${sentence}`;
  return html.slice(0, block.innerEnd) + addition + html.slice(block.innerEnd);
}

// ─── rel-доли и рендер ссылок при отдаче (чистые, тестируемые) ───────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Rel по долям на `count` сайтов: наибольший остаток + детерминированное перемешивание.
 *  Заменяет сломанный pickRel (делил позицию на сумму весов → всем доставался dofollow). */
export function planRel(relShares: Partial<Record<Rel, number>>, count: number, seed: number): Rel[] {
  const kinds: Rel[] = ["dofollow", "nofollow", "sponsored"];
  const weights = kinds.map(k => Math.max(0, relShares[k] ?? (k === "dofollow" ? 1 : 0)));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const raw = weights.map(w => (w / total) * count);
  const quota = raw.map(Math.floor);
  let assigned = quota.reduce((s, q) => s + q, 0);
  const rema = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (let r = 0; assigned < count; r++, assigned++) quota[rema[r % rema.length].i] += 1;
  const pool: Rel[] = [];
  kinds.forEach((k, i) => { for (let j = 0; j < quota[i]; j++) pool.push(k); });
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool;
}

export interface RenderLink {
  pagePath: string;
  anchorText: string;
  targetUrl: string;
  rel: string;
  placement: string;           // content | footer | nav
  surroundingText?: string;
  status: string;              // только placed рендерится
}

/**
 * Запечь ссылки в страницу ПРИ ОТДАЧЕ. На вход — ЧИСТАЯ (pristine) страница с диска и строки
 * ссылок этой страницы; на выход — HTML с внедрёнными ссылками. Детерминированно: место ищется
 * тем же choosePlacement по чистому HTML, поэтому повторный рендер идемпотентен, а правка строки
 * ссылки сразу меняет выдачу без перезаливки файла.
 */
export function renderPage(pristineHtml: string, links: RenderLink[]): string {
  let html = pristineHtml;
  for (const l of links) {
    if (l.status !== "placed") continue;
    const tag = buildAnchorTag(l.targetUrl, l.anchorText, (l.rel as Rel) || "dofollow");
    if (l.placement === "footer" || l.placement === "nav") {
      const sentence = l.surroundingText && l.surroundingText.includes("{link}") ? l.surroundingText.replace("{link}", tag) : tag;
      const para = `<p>${sentence}</p>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${para}</body>`) : html + para;
    } else {
      const choice = choosePlacement(html, l.anchorText);
      if (choice.block) html = injectIntoBlock(html, choice.block, tag, l.surroundingText);
      else html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `<p>${tag}</p></body>`) : html + `<p>${tag}</p>`;
    }
  }
  return html;
}

/**
 * Ссылки, которые рендерятся в файл `fileRel` (путь внутри сайта: "index.html" — морда,
 * "about/index.html" — раздел). Общий фильтр для ZIP-роута и MCP-экспорта: UI и MCP обязаны
 * собирать ссылки одинаково (правило «MCP = UI»), поэтому логика — в одном месте, а не в двух
 * копиях, которые разъедутся при первой же правке.
 */
export function linksForPage(links: RenderLink[], fileRel: string): RenderLink[] {
  if (fileRel === "index.html") {
    return links.filter(l => l.status === "placed" && (l.pagePath === "/" || l.pagePath === "*"));
  }
  const pageRel = "/" + fileRel.replace(/index\.html$/i, "").replace(/\/$/, "");
  return links.filter(l => l.status === "placed" && (l.pagePath === pageRel || l.pagePath === "*"));
}
