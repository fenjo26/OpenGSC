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
  const href = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
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
