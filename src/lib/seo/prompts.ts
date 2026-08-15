// Prompt builders for the SEO Tools module (spec §4 outline, §11 gap-report)
// plus a JSON extraction helper for parsing strict-JSON LLM responses.

import { renderPolicy, EditorialPolicy } from "./policy";

// Local currency hint by country (so prices match the target region, not USD by default).
const EUR = ["gr", "de", "fr", "it", "es", "pt", "nl", "be", "at", "ie", "fi", "sk", "si", "lt", "lv", "ee", "cy", "mt", "lu", "hr"];
export function currencyHint(country?: string): string {
  const c = (country || "").toLowerCase();
  if (EUR.includes(c)) return "EUR (€)";
  const map: Record<string, string> = { gb: "GBP (£)", us: "USD ($)", ca: "CAD ($)", au: "AUD ($)", nz: "NZD ($)", ch: "CHF", se: "SEK", no: "NOK", dk: "DKK", pl: "PLN (zł)", cz: "CZK", hu: "HUF", ro: "RON", bg: "BGN", ua: "UAH (₴)", ru: "RUB (₽)", tr: "TRY (₺)", jp: "JPY (¥)", in: "INR (₹)", br: "BRL (R$)", mx: "MXN ($)" };
  return map[c] || "местная валюта региона";
}

// Cross-cutting anti-fabrication rule injected into both outline and text prompts.
const NO_FABRICATION = `ФАКТЫ (КРИТИЧНО — пиши богато и ТОЧНО): опирайся на реальные данные. Активно используй проверенные, общеизвестные факты о предмете — реальные характеристики (экран, память, чип, разрешение), реальные названия моделей/версий/игр/аксессуаров/ритейлеров, известные цены/MSRP и даты — И данные из источников/конкурентов. Конкретика и цифры приветствуются, когда они настоящие: именно это делает статью полезной и цитируемой. НО НЕ выдумывай того, чего может не существовать или в чём не уверен: не сочиняй несуществующие модели/версии/варианты («OLED-версия», если её нет), не угадывай характеристики/цены/даты/названия. Если точного значения нет ни в источниках, ни в достоверных знаниях — обобщи («доступны разные комплекты», «уточняйте у продавца»), НЕ подставляй выдуманное число. Правило: уверен, что факт реальный — пиши конкретно; не уверен — обобщай, но не фантазируй. Особое внимание к точным названиям (например название игры бери точное, не приблизительное).`;

export interface CompetitorInput {
  position: number;
  url: string;
  site_type?: string;
  intent?: string;
  title: string;
  headings: string[];
  word_count: number;
  has_price_table: boolean;
  has_faq: boolean;
  text_sample?: string;   // real scraped page text → grounds the outline in facts
  extracted?: string;     // compact per-source facts from the map stage (specs/prices/entities)
}

// ─── Map stage: extract compact facts from ONE source (run per competitor, in parallel) ──────────
// Vocabulary ban list, injected into the generation prompts from the AI-fingerprint model.
//
// Note what this block deliberately does NOT contain: any instruction about HOW to write. Telling a
// model to "write more naturally", "vary sentence length" or "avoid sounding like AI" backfires —
// the model applies such directives as explicit rules, which narrows its output distribution and
// makes the result more machine-typical, not less. Naming concrete words to avoid carries none of
// that failure mode: it removes specific high-signal tokens without prescribing a style.
export function bannedWordsBlock(words?: string[]): string {
  const list = Array.from(new Set((words || []).map(w => String(w).trim().toLowerCase()).filter(Boolean))).slice(0, 80);
  if (!list.length) return "";
  return `\nЗАПРЕЩЁННАЯ ЛЕКСИКА: не используй эти слова и любые их словоформы: ${list.join(", ")}. Ту же мысль передавай другими словами — НЕ подставляй синоним-заменитель механически, перестраивай фразу.\n`;
}

export function buildSourceExtractPrompt(args: { url: string; title: string; text: string; keyword: string; country?: string }): string {
  return `Ты — экстрактор фактов. Из текста ОДНОГО источника по теме "${args.keyword}"${args.country ? `, регион ${args.country}` : ""} вытащи ТОЛЬКО реально присутствующие в тексте факты — НИЧЕГО не выдумывай и не достраивай. Верни СТРОГИЙ компактный JSON без обёрток:
{ "specs": { "Атрибут": "значение" }, "prices": ["цена + что это"], "key_facts": ["краткий факт"], "entities": ["сущность"], "headings_covered": ["тема/подзаголовок страницы"] }
ПРАВИЛА: значения бери дословно из текста; если чего-то нет — пустой массив/объект. Максимум ~12 фактов и ~12 сущностей. Цены — как в тексте (валюту не меняй). Спеки — характеристики товара (экран, память, чип и т.п.) ровно как написано.

ИСТОЧНИК: ${args.title} (${args.url})
ТЕКСТ:
${(args.text || "").slice(0, 6000)}`;
}

// ─── Outline generation prompt (rich, EAV-style — spec §4 + reference parity) ─────
export function buildOutlinePrompt(args: {
  keyword: string;
  language: string;
  country: string;
  competitors: CompetitorInput[];
  policy?: EditorialPolicy;
  paa?: string[];
  related?: string[];
  tone?: string;
  persona?: string;
  additionalKeywords?: string;
  lsiKeywords?: string;
  targetWordCount?: number;
  manualTexts?: { name: string; text: string }[];
  keywordsData?: { keyword: string; volume: number; globalVolume?: number | null; intent?: string }[];
  /**
   * Which provider `keywordsData` came from — "Ahrefs", "Semrush", "DataForSEO".
   * Named in the prompt instead of hardcoded, because the model is being told to trust these
   * numbers and the label should match what was actually bought.
   */
  keywordsSource?: string;
  pageGoal?: "informational" | "commercial" | "mixed";
  narration?: "first" | "third";
  customTemplate?: string;
  structureRules?: string;
  ragFacts?: string;
  lightSections?: boolean; // enrichment pass will deepen sections — keep the skeleton lean & fast
  bannedWords?: string[];
}): string {
  // Tone is rendered once: folded into the policy block (override) when a policy exists,
  // otherwise as a standalone line. Never both → no conflicting tone signals.
  const policyBlock = args.policy ? renderPolicy(args.policy, args.tone) + "\n\n" : "";
  const paaBlock = args.paa?.length ? `\nPeople-Also-Ask из выдачи: ${JSON.stringify(args.paa)}` : "";
  // Whether real demand data reached this call. Two blocks below depend on it, and they used to
  // disagree: the data block vanished when the list was empty while the rule telling the model to
  // sort headings BY that data stayed. The result looked methodical and was built on invented
  // frequencies — worse than an obvious gap, because a plausible number is indistinguishable from
  // a real one on screen. One flag now drives both.
  const hasKwData = !!args.keywordsData?.length;
  // Whether the provider actually returned an intent for anything.
  //
  // Separate from `hasKwData` because the two fail independently: the live instance currently has
  // 152 cached keywords and not one carries an intent, since Ahrefs does not compute it for
  // zero-volume brand terms. Telling the model to "group keys by intent" when no key has one is
  // the same defect as ranking headings by frequencies that were never fetched — it produces a
  // confident structure built on a field nobody supplied.
  const hasIntent = !!args.keywordsData?.some(k => k.intent && k.intent !== "unknown");
  const kwSource = args.keywordsSource || "внешний источник";
  // Each key carries its search intent (transactional/commercial/informational/navigational) and,
  // when the local volume is zero, a worldwide figure. The intent drives placement — a
  // transactional key belongs on a commercial section, not an FAQ — and the global figure keeps a
  // zero-local brand/niche term from being dropped as worthless.
  const kwData = hasKwData
    ? `\n- РЕАЛЬНЫЕ КЛЮЧИ С ОБЪЁМАМИ И ИНТЕНТОМ (${kwSource} — используй ИМЕННО ЭТИ формулировки в section.keywords; приоритет ключам с бОльшим ОБЩИМ объёмом = max(volume, globalVolume); распределяй по релевантным секциям). Формат: "ключ (локальный объём/мес, 🌍глобальный, интент)". Где объём локальный = 0, но есть 🌍глобальный — ключ НЕ мёртв, это просто низкий местный спрос, используй его по интенту: ${JSON.stringify(args.keywordsData!.slice(0, 50).map(k => `${k.keyword} (${k.volume}/мес${k.globalVolume ? `, 🌍${k.globalVolume}` : ""}${k.intent && k.intent !== "unknown" ? `, ${k.intent}` : ""})`))}`
    : "";
  const relBlock = args.related?.length ? `\nСвязанные запросы: ${JSON.stringify(args.related)}` : "";
  const toneBlock = args.tone && !args.policy ? `\n- тон повествования: ${args.tone}` : "";
  const personaBlock = args.persona ? `\n- от лица: ${args.persona}` : "";
  const narrationBlock = args.narration
    ? `\n- лицо повествования: ${args.narration === "first" ? "ПЕРВОЕ лицо — экспертный «я»-голос (личный опыт, рекомендации от себя, «я проверял…»)" : "ТРЕТЬЕ лицо — корпоративный нейтральный голос (без «я», от лица компании)"}. Установи meta.narration = "${args.narration}".`
    : "";
  const customTplBlock = args.customTemplate?.trim()
    ? `\n\nПОЛЬЗОВАТЕЛЬСКИЙ ШАБЛОН СТРУКТУРЫ (ВЫСШИЙ ПРИОРИТЕТ — каркас): используй ИМЕННО эти заголовки H1/H2/H3, в ТОМ ЖЕ порядке и с той же формулировкой (язык заголовков адаптируй под язык статьи, если шаблон на другом). НЕ переименовывай по смыслу, не выкидывай и не переставляй заданные пункты. При этом ОБОГАЩАЙ шаблон: внутри крупных шаблонных H2 ДОБАВЛЯЙ 2-4 СВОИХ H3-подсекции (сразу после их H2, до следующего шаблонного H2), покрывающих реальные под-интенты темы — шаблон задаёт каркас, а полнота набирается твоими H3. Детально заполняй все секции по EAV.\n${args.customTemplate.trim().slice(0, 4000)}`
    : "";
  const structRulesBlock = args.structureRules?.trim()
    ? `\n\nПРАВИЛА СТРУКТУРЫ ОТ ПОЛЬЗОВАТЕЛЯ (учитывай ОБЯЗАТЕЛЬНО при построении секций — это указания, как организовать статью): ${args.structureRules.trim().slice(0, 1500)}`
    : "";
  const addKw = args.additionalKeywords?.trim() ? `\n- доп. ключевые слова (обязательно учесть): ${args.additionalKeywords}` : "";
  const lsiKw = args.lsiKeywords?.trim() ? `\n- LSI-фразы (вплетай в значения атрибутов сущностей и в текст секций естественно, не в заголовки): ${args.lsiKeywords}` : "";
  const twc = args.targetWordCount ? `\n- целевой объём статьи: ~${args.targetWordCount} слов — РАСПРЕДЕЛИ его по секциям: СУММА word_count_total всех секций должна быть ≈${args.targetWordCount} (±10%)` : "";
  const manual = args.manualTexts?.length
    ? `\n- ручные тексты конкурентов (скрейп не справился): ${JSON.stringify(args.manualTexts.map(m => ({ name: m.name, text: m.text.slice(0, 6000) })))}`
    : "";
  // Real scraped competitor content → primary grounding for hard specifics. Official/brand sources first.
  // Keep the outline input bounded (official source first, deeper; others trimmed) so the model
  // doesn't blow the token budget and truncate the JSON. Full-depth text still flows to the TEXT step.
  // Prefer the compact per-source extraction (map stage); fall back to raw text if not extracted.
  const compRanked = args.competitors
    .filter(c => (c.extracted && c.extracted.trim()) || (c.text_sample && c.text_sample.trim().length > 80))
    .sort((a, b) => (b.site_type === "official_store" ? 1 : 0) - (a.site_type === "official_store" ? 1 : 0))
    .slice(0, 8);
  const compFacts = compRanked
    .map((c, i) => {
      const body = c.extracted?.trim()
        ? c.extracted.trim().slice(0, 1600)
        : (c.text_sample || "").replace(/\s+/g, " ").trim().slice(0, c.site_type === "official_store" ? 3500 : 2000);
      return `[${i + 1}]${c.site_type === "official_store" ? " (ОФИЦИАЛЬНЫЙ ИСТОЧНИК — высший приоритет)" : ""} ${c.url}\n${body}`;
    }).join("\n\n");
  const factsBlock = compFacts
    ? `\n\nРЕАЛЬНЫЙ КОНТЕНТ КОНКУРЕНТОВ/ИСТОЧНИКОВ ИЗ ТОПА ВЫДАЧИ (главная опора для конкретики): извлекай отсюда ВСЕ конкретные значения — точные цены/суммы, названия моделей/версий/изданий, характеристики, объёмы памяти, даты, имена игр/товаров/ритейлеров. Если есть «(ОФИЦИАЛЬНЫЙ ИСТОЧНИК)» — доверяй ему в первую очередь. ПРАВИЛО: бери конкретику отсюда ИЛИ из достоверных общеизвестных фактов, в которых уверен; если значения нет ни тут, ни в надёжных знаниях — обобщи (диапазон/ориентир) и пометь копирайтеру «уточнить из источников», но НЕ подставляй выдуманное число и НЕ вставляй токен в заголовки/summary. Названия (игр/моделей) бери ТОЧНЫЕ. Цены — в валюте региона. Текст не копируй дословно — извлекай факты.\n${compFacts}`
    : `\n\nЗАЗЕМЛЕНИЕ (текстов конкурентов нет): подтверждённого источника конкретики нет. Можешь опираться на достоверные общеизвестные факты о предмете (реальные характеристики, точные названия), но НЕ выдумывай неуверенных цен/спеков/дат/изданий — такие места держи качественными (диапазон/ориентир) и помечай «уточнить из источников при написании». Структуру, сущности и ключи раскрывай полноценно — ограничение касается ТОЛЬКО придуманной неуверенной конкретики.`;

  // Knowledge-base (RAG) facts: verified entity attributes — same trust tier as an official source.
  const ragBlock = args.ragFacts?.trim()
    ? `\n\nБАЗА ЗНАНИЙ (ПРОВЕРЕННЫЕ ФАКТЫ О СУЩНОСТЯХ — доверяй как официальному источнику): используй эти атрибуты (RTP, волатильность, провайдер, даты, ставки, фичи) как достоверные значения — вплетай в summary секций, атрибуты сущностей и visual_elements-таблицы. НЕ противоречь этим данным и НЕ заменяй их выдуманными.\n${args.ragFacts.trim().slice(0, 6000)}`
    : "";
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const goal = args.pageGoal || "mixed";
  const goalBlock = goal === "commercial"
    ? `\n\nЦЕЛЬ СТРАНИЦЫ: КОММЕРЧЕСКАЯ (продающая, под конверсию). meta.dominant_intent = "commercial".
- title_options и description_options — ПРОДАЮЩИЕ: позиционируй услугу и выгоду, конверсионные хуки (бронирование, "best/private/door-to-door", "от €X", надёжность, без скрытых доплат), бренд-ready. НЕ информационные «Guide / How to / Comparison».
- description_options — с УТП и мягким CTA (забронировать / проверить цену).
- Структура: помимо честного сравнения вариантов добавь ПРОДАЮЩИЕ секции: «зачем бронировать заранее», «наша услуга и типы авто (sedan / minivan / minibus)», «что включено», «как забронировать (по шагам)», «вердикт + CTA». Голос — эксперт, который сам оказывает услугу (первое лицо).
- copywriter_notes ведут читателя к целевому действию, но альтернативы (такси/автобус/аренда) описывай честно, не обесценивая.`
    : goal === "informational"
    ? `\n\nЦЕЛЬ СТРАНИЦЫ: ИНФОРМАЦИОННАЯ (справочная). meta.dominant_intent = "informational".
- title_options / description_options — справочные и исчерпывающие («Guide», «How to», «Distance, Time & Cost»), без продаж и без CTA.
- Голос — нейтральный эксперт; равномерно и полно покрой все под-вопросы.`
    : `\n\nЦЕЛЬ СТРАНИЦЫ: СМЕШАННАЯ. Информационный каркас (полнота под-интентов) + коммерческие вставки (позиционирование услуги, типы авто, как забронировать) + мягкий CTA в конце. meta.dominant_intent = "commercial_investigation". title_options — гибрид: информативные, но с конверсионным хуком.`;
  return `${policyBlock}${bannedWordsBlock(args.bannedWords)}Ты — SEO-стратег и entity-аналитик. На основе анализа топ-конкурентов из выдачи построй ИСЧЕРПЫВАЮЩУЮ структуру статьи (outline) в EAV-модели (Entity-Attribute-Value), которая полнее и авторитетнее конкурентов и максимально цитируема в ИИ-поиске. Верни СТРОГИЙ JSON без преамбулы и без markdown-обёрток.

АКТУАЛЬНОСТЬ: сегодня ${today}. Если в заголовках/тексте уместен год — используй ТЕКУЩИЙ (${year}); НИКОГДА не подставляй устаревшие годы (2023/2024) и не выдумывай год — лучше без года, чем неверный.${goalBlock}

ПРИНЦИПЫ:
- Структура отвечает на реальные sub-intents пользователей; front-load ключевые факты (цена/время/расстояние) в первые секции.
- Веса [10] — самые важные сущности темы, [5-7] — поддерживающие/географические.
- Для коммерческих тем — нейтральное сравнение ВСЕХ вариантов (включая те, что автор не продаёт).
- НЕ выдумывай лицензии/регалии/отзывы. Помечай секции needs_real_experience=true, где уместен реальный личный опыт (не выдуманный).
- ${NO_FABRICATION}
- РЕГИОН: пиши под регион «${args.country}»: цены/суммы в валюте региона — ${currencyHint(args.country)} (НЕ в USD по умолчанию); ритейлеры и реалии — релевантные региону (для Греции/ЕС — местные магазины и маркетплейсы, без Walmart и подобных, которых там нет).

ТРЕБОВАНИЯ К ДЕТАЛИЗАЦИИ (ЖЁСТКО, иначе аутлайн бесполезен — по нему пишут идеальную статью):
- ГЛУБИНА И ВЛОЖЕННОСТЬ (КРИТИЧНО): почти каждый содержательный H2 ОБЯЗАН иметь 2-4 вложенных H3. H3 — это ОТДЕЛЬНЫЙ элемент массива sections с "h_level":"H3", идущий сразу ПОСЛЕ своего H2. Крупные/коммерческие H2 (сравнение вариантов, цены, бронирование, услуга/автопарк, безопасность) — минимум 3 H3 каждый. У H2 word_count_self делай маленьким (30-60 слов вступления), основной объём — в H3. НЕ делай плоский список из одних H2.
- ПЛОТНОСТЬ ЗАГОЛОВКОВ (ПРИВЯЗАНА К ОБЪЁМУ): одна секция ≈ 100 слов итогового текста. Число секций (H2+H3 суммарно) = целевой объём / 100${args.targetWordCount ? ` — для цели ~${args.targetWordCount} слов это ≈${Math.max(10, Math.min(32, Math.round(args.targetWordCount / 100)))} секций` : " (не задан объём — 18-24 секции)"}. БОЛЬШЕ секций = каждая станет тощим огрызком, МЕНЬШЕ = потеря полноты. Почти каждый содержательный H2 имеет 2-4 вложенных H3; покрывай реальные sub-intents, не плоди пустые.
- БЮДЖЕТ ОБЪЁМА (КРИТИЧНО): word_count_total КАЖДОЙ секции РАССЧИТАЙ САМ по её важности — числа в схеме ниже ([0,0]) это НЕ значения по умолчанию, их обязательно заменить. СУММА word_count_total по ВСЕМ секциям = целевой объём статьи (±10%); если целевой объём не задан — считай ~2000 слов. Крупные содержательные H2 — 200-400 слов (через свои H3), H3 — 80-160, вводные/мелкие — меньше. НЕ ставь всем секциям одинаковый маленький бюджет.
- СУЩНОСТИ: ${args.lightSections ? "2-4 на секцию" : "для крупных секций 4-7 сущностей, для мелких H3 — 2-3"}. У КАЖДОЙ — weight И role: {"name":"","weight":10,"role":"primary — ядро секции"} или "secondary — регуляторная валидация/социальное доказательство/контекст рынка". РАЗНООБРАЗИЕ ОБЯЗАТЕЛЬНО: НЕ ставь во все секции один лишь главный бренд — добавляй регуляторов (лицензии), платёжные системы, типы игр/ставок/продуктов, лиги/турниры, провайдеров, площадки отзывов (Trustpilot) и т.п.
- КЛЮЧИ: 3-6 ПОЛНЫХ поисковых фраз на секцию (реальные запросы, напр. "how far is pefkohori from thessaloniki airport"), а НЕ слова-обрывки ("distance, time"). ${hasKwData ? "Бери формулировки из блока с объёмами выше, остальное — реалистичный длинный хвост." : "Данных о частотности нет — формулируй реалистичные запросы сам."}
${hasKwData
  ? `- ЧАСТОТНОСТЬ → УРОВЕНЬ ЗАГОЛОВКА (по методике Rush): распредели ключи по ОБЩЕМУ объёму из блока выше. ВЧ (самые объёмные, max(volume, globalVolume), 1-2 слова) → в H1 и крупные H2. СЧ (уточняющие, 2-3 слова) → в H2. НЧ/длинный хвост (4+ слов, конкретные вопросы) → в H3 (там ключи можно склонять). Не дублируй один ключ во многих заголовках — раскидывай.${
  hasIntent
    ? `
- ИНТЕНТ → ТИП СЕКЦИИ: группируй ключи по интенту, указанному у каждого ключа выше. transactional/commercial → в продающие секции (услуга, цены, бронирование, CTA, сравнение). informational → в справочные/FAQ/guide. navigational → рядом с упоминанием бренда/продукта.`
    : `
- ИНТЕНТ: провайдер не вернул интент ни по одному ключу. НЕ помечай ключи как transactional/informational/navigational и не раскладывай секции по придуманному интенту — определяй тип секции по самой формулировке запроса и по структуре конкурентов.`}`
  : `- ЧАСТОТНОСТЬ: данных о частотности НЕТ. НЕ ранжируй заголовки по «ВЧ/СЧ/НЧ» и НЕ приписывай ключам объёмы поиска — выдуманная частотность хуже её отсутствия. Опирайся на структуру конкурентов и логику темы: общее — выше, частное — глубже.`}
- H1 ≠ TITLE: H1 (заголовок на странице) и Title (тег для выдачи) — РАЗНЫЕ формулировки, обе с ключами. H1 — цепляющий, для читателя, с ВЧ-ключом; Title — под клик в выдаче. Заполни meta.h1 отдельным от title_options заголовком (с ТЕКУЩИМ годом, если год уместен).
${args.lightSections
  ? `- SUMMARY: 1-2 предложения — суть секции с 1-2 конкретными ориентирами (детализация будет углублена отдельным проходом — сейчас важнее ПОЛНОТА СТРУКТУРЫ, а не длина полей).
- COPYWRITER_NOTES: 1-2 предложения — главный факт/приём секции.
- ENTITY_CONNECTIONS: 1-2 триплета на секцию (subject→predicate→object со strength 1-10).`
  : `- SUMMARY: 3-5 предложений с КОНКРЕТНЫМИ числовыми ориентирами (расстояние в км, время в мин/ч, цены в валюте, характеристики) — реальными: взятыми из текстов конкурентов/источников ИЛИ из достоверных общеизвестных фактов, в которых уверен. Если точного значения нет ни там, ни в надёжных знаниях — дай диапазон/ориентир и пометь «уточнить из источников», НЕ выдумывай точную цифру. Цель — насыщенно и точно, без фейковой точности.
- COPYWRITER_NOTES: развёрнутый абзац (4-6 предложений) в заданном tone/persona (если persona от первого лица — экспертный «я»-голос). Конкретно: какой факт/анекдот/таблицу/чек-лист дать, как вплести сущности, чем открыть и чем закрыть секцию.
- ENTITY_CONNECTIONS: 3-5 триплетов на секцию (subject→predicate→object со strength 1-10).`}
- VISUAL_ELEMENTS: где уместно — таблицы сравнения, инфографики маршрута, чек-листы, флоучарты бронирования (с title и description).
- FAQ: 3-5 вопросов, для КАЖДОГО заполни answer_guideline (40-60 слов, какие сущности/цифры задействовать).
- SUB_INTENTS: 8-12 реальных под-интентов (вопросов пользователей) с section/coverage/word_count/entities.
- ENTITY_ANALYSIS: заполни КОМПАКТНО, но по делу — content_strategy (по 2-3 пункта в подблоках), primary_entity (атрибуты+триплеты+authority_validation), supporting_entities (3-4 сущности), keyword_strategy (primary/lsi/long_tail по 2-3 с usage), visual_elements (1-2 с prompt). Не раздувай — лаконично и полезно.

ДАНО:
- keyword: ${args.keyword}
- язык/страна: ${args.language}/${args.country}${toneBlock}${personaBlock}${narrationBlock}${addKw}${lsiKw}${twc}${paaBlock}${relBlock}
- топ-конкуренты (типы + структура): ${JSON.stringify(args.competitors.map(({ text_sample, ...c }) => { void text_sample; return c; }))}${manual}${kwData}${customTplBlock}${structRulesBlock}${factsBlock}${ragBlock}

МЕТА-ТЕГИ (title/description/slug) — по правилам Google и Bing, проработай ТЩАТЕЛЬНО (это готовые к публикации варианты):
- title_options (3 шт.): 50–60 символов (под ~600px, иначе обрежется в выдаче). Главный ключ — в САМОМ НАЧАЛЕ. Если бренд известен — в конце через « | » или « - ». Формула: [Главный ключ] - [Вторичный ключ/УТП] | [Бренд]. Коммерческие — продающий хук (Buy/Best/от €X/Free shipping); информационные — «How to / Guide / Число + …»; числа и скобки повышают CTR. Bing любит точное вхождение ключа.
- description_options (2 шт.): ~150–155 символов (влезает и в Google ≤160, и в Bing). Ценность с ключами + конкретная выгода/деталь + явный CTA для коммерции (Shop now / Book / Get a quote); для информационных — что внутри, без продаж. Формула: [Ценность с ключами]. [Выгода/деталь]. [CTA].
- slug_options (2 шт.): 3–5 слов, ТОЛЬКО строчные латинские буквы и дефисы, БЕЗ стоп-слов (a, an, the, in, on, of, and, for…), без подчёркиваний, пробелов, года и спецсимволов. Не-латиницу транслитерируй. Примеры: "ergonomic-office-chairs", "start-vegetable-garden-beginners", "best-project-management-software".
Текст title/description — на языке ${args.language}; slug — всегда латиницей. Всё — под главный ключ и dominant_intent.

ВЕРНИ JSON строго по схеме (только JSON):
{
  "meta": { "keyword": "", "h1": "", "title_options": ["","",""], "description_options": ["",""], "slug_options": ["",""], "target_word_count": 0, "dominant_intent": "", "tone": "", "persona": "", "narration": "first|third" },
  "entities": [ { "name": "", "type": "Place|Service|Vehicle Type|Company|Transport Mode|Concept", "weight": 10, "attributes": { "Attr_Name": "Value" }, "relationship_triplets": ["Subject → predicate → Object [9]"] } ],
  "sub_intents": [ { "intent": "", "section": "H3 ...", "coverage": "как раскрыть", "word_count": "100+", "entities": [""] } ],
  "sections": [ {
    "h_level": "H2",
    "heading": "",
    "word_count_total": [0,0],
    "word_count_self": [0,0],
    "entities_to_cover": [ { "name": "", "weight": 10, "role": "primary|secondary — роль сущности в секции" } ],
    "keywords": [""],
    "summary": "",
    "visual_elements": [ { "type": "table|infographic|list|checklist|flowchart", "title": "", "description": "" } ],
    "copywriter_notes": "",
    "entity_connections": [ { "subject": "", "predicate": "", "object": "", "strength": 10 } ],
    "needs_real_experience": false
  } ],
  "faq": [ { "question": "", "answer_guideline": "40-60 слов, конкретно" } ],
  "entity_analysis": {
    "content_strategy": {
      "structure_advantages": ["оптимальный поток секций","визуальная стратегия","стратегия цитирования авторитетов"],
      "entity_advantages": ["уникальные комбинации сущностей","глубокое покрытие атрибутов","сильные сигналы авторитетности","маппинг связей"],
      "structure_superiority": ["прямой ответ на интент","системное покрытие","логичный поток","интеграция авторитета"],
      "authority_signals": ["верификационные бейджи","официальная инфо о маршруте","выдержки из отзывов"]
    },
    "primary_entity": { "name": "", "attributes": { "Attr_Name": "Value" }, "relationship_triplets": ["Subject → predicate → Object [10]"], "authority_validation": "лицензии/инспекции/сертификаты — реальные или плейсхолдер" },
    "supporting_entities": [ { "name": "", "attributes": { "Attr": "Value" }, "relationship_to_primary": "Entity → predicate → Primary", "content_integration": "в каких секциях раскрывается" } ],
    "keyword_strategy": {
      "primary": [ { "keyword": "", "usage": "как и сколько раз вплести через атрибуты сущности" } ],
      "lsi": [ { "keyword": "", "usage": "через значения атрибутов" } ],
      "long_tail": [ { "keyword": "", "usage": "через предикаты связей" } ]
    },
    "visual_elements": [ { "name": "", "purpose": "", "eav_data": "какие атрибуты визуализируются", "prompt": "промпт для генерации этого визуала" } ]
  },
  "price_table_template": { "columns": [""], "rows": [ {} ] },
  "authority_fields_to_fill_by_user": [ "" ]
}`;
}

// ─── Structure expansion: propose extra H3s under thin H2s (template mode & flat outlines) ──
// Models are conservative with user templates and often return the bare skeleton. This pass
// asks ONLY for insertions (new H3s under existing H2s), which we merge deterministically —
// so template headings are never touched, but depth matches reference-grade outlines.
export function buildStructureExpandPrompt(args: {
  keyword: string;
  language: string;
  country: string;
  pageGoal?: "informational" | "commercial" | "mixed";
  paa?: string[];
  maxAdd?: number; // hard cap on new H3s (derived from the word-count target)
  sections: { h_level: string; heading: string }[];
  /**
   * Whole H2 topics the outline is missing — normally the `section` labels of sub-intents that
   * no existing heading covers. Present only in deficit mode, where the outline is too SHORT
   * overall rather than merely too flat, and grafting H3s under what survived cannot fix it.
   */
  missingTopics?: string[];
  /** Deficit mode: the pass may append whole new H2 blocks, not just H3s under existing ones. */
  allowNewH2?: boolean;
  /** How many sections the word target calls for — quoted so the model aims at a real number. */
  targetSections?: number;
}): string {
  const goal = args.pageGoal === "commercial" ? "коммерческая (конверсионная)" : args.pageGoal === "informational" ? "информационная (справочная)" : "смешанная";
  const paa = args.paa?.length ? `\n- вопросы пользователей из выдачи (покрой релевантные новыми подсекциями): ${JSON.stringify(args.paa.slice(0, 10))}` : "";
  const missing = args.missingTopics?.length
    ? `\n- ТЕМЫ, КОТОРЫХ В СТРУКТУРЕ НЕТ (их запланировали в под-интентах, но соответствующих секций нет — восстанови их В ПЕРВУЮ ОЧЕРЕДЬ): ${JSON.stringify(args.missingTopics.slice(0, 14))}`
    : "";
  // Two different defects, one pass. "Flat" = enough sections, not enough depth → H3s only.
  // "Deficit" = the structure is simply too small for the article's word target, which is what a
  // response cut off mid-`sections` leaves behind: the surviving H2s can look perfectly deep, so
  // an H3-only repair reports success and changes nothing.
  const diagnosis = args.allowNewH2
    ? `Она НЕПОЛНАЯ: секций СЛИШКОМ МАЛО для заданного объёма статьи${args.targetSections ? ` (сейчас ${args.sections.length}, нужно ≈${args.targetSections})` : ""} — часть тем вообще не раскрыта. Дострой её: добавь НЕДОСТАЮЩИЕ H2-темы (каждую сразу с 2-4 своими H3) и H3 под существующие H2.`
    : `Она слишком ПЛОСКАЯ — крупным H2 не хватает H3-подсекций, покрывающих реальные под-интенты пользователей. Предложи ДОПОЛНИТЕЛЬНЫЕ H3.`;
  const placementRule = args.allowNewH2
    ? `- "after_heading" — ТОЧНЫЙ текст существующего H2, ПОСЛЕ блока которого вставить (вставка идёт после всех его H3). Чтобы дописать блок в САМЫЙ КОНЕЦ статьи, поставь "after_heading": "END".
- Новый H2 подавай ОДНОЙ вставкой вместе со своими H3: [{"h_level":"H2",...},{"h_level":"H3",...},{"h_level":"H3",...}] — H3 идут сразу за своим H2 в том же массиве.
- word_count_total: для нового H2 — [40, 80] (это только его вступление, основной объём в H3), для нового H3 — [80, 160].
- Порядок логичный: справочное выше, коммерческое и служебное (гарантии, безопасность, как заказать) ниже. Секцию FAQ НЕ создавай — она формируется отдельно.`
    : `- "after_heading" — ТОЧНЫЙ текст существующего H2, под который вставить.
- word_count_total для нового H3: [80, 160].
- НЕ добавляй новых H2.`;
  return `Сегодня ${new Date().toISOString().slice(0, 10)} — если в формулировках уместен год, используй ТОЛЬКО текущий (${new Date().getFullYear()}); НИКОГДА не пиши 2023/2024/2025.\n\nТы — SEO-стратег. Ниже структура статьи по теме "${args.keyword}" (язык ${args.language}, регион ${args.country}, цель страницы: ${goal}). ${diagnosis} Существующие заголовки НЕ трогай, НЕ переименовывай, НЕ переставляй — только вставки. Верни СТРОГИЙ JSON без преамбулы и markdown-обёрток.

ПРАВИЛА:
- Для КАЖДОГО содержательного H2, у которого меньше 2 своих H3, предложи 2-4 новых H3 (для мелких/служебных H2 вроде FAQ/поддержки — можно 0-1 или пропустить).
- Подсекции — конкретные под-интенты: типы/варианты/шаги/сравнения/условия/цены/география (напр. для услуги: «Цены по типу помещения», «Что входит в базовый пакет», «Как записаться за 3 шага», «Районы обслуживания»; для казино: «Условия отыгрыша (wagering)», «Демо-режим»).
- Заголовки — на языке ${args.language}, с НЧ-ключами, без дублей существующих.
${placementRule}
- Суммарно добавь НЕ БОЛЬШЕ ${Math.max(2, args.maxAdd ?? 12)} новых секций по всей статье — выбирай САМЫЕ важные под-интенты, остальные пропусти.

СТРУКТУРА СЕЙЧАС: ${JSON.stringify(args.sections)}${missing}${paa}

ВЕРНИ JSON строго по схеме:
{ "insertions": [ { "after_heading": "точный H2${args.allowNewH2 ? ` или \\"END\\"` : ""}", "sections": [ { "h_level": "${args.allowNewH2 ? "H2|H3" : "H3"}", "heading": "", "word_count_total": [80,160], "summary": "1-2 предложения — что раскрыть" } ] } ] }`;
}

// ─── FAQ backfill: rebuild the FAQ block when the outline came back without one ────
// `faq` sits near the END of the outline schema, so it is the first thing lost whenever the
// model's response is cut short — and losing it is expensive twice over. The article loses its
// question block (the part that wins People-Also-Ask and AI-answer citations), and the word-budget
// guard reserves nothing for it, so the full article target gets pushed into the body sections,
// inflating every one of them. Regenerating it costs one small call against material the outline
// already produced.
export function buildFaqBackfillPrompt(args: {
  keyword: string;
  language: string;
  country: string;
  pageGoal?: "informational" | "commercial" | "mixed";
  count?: number;
  headings?: string[];
  subIntents?: string[];
  paa?: string[];
}): string {
  const n = Math.max(3, Math.min(10, args.count ?? 8));
  const goal = args.pageGoal === "commercial" ? "коммерческая" : args.pageGoal === "informational" ? "информационная" : "смешанная";
  const heads = args.headings?.length ? `\n- заголовки статьи (НЕ дублируй их вопросами — FAQ закрывает то, что в них не поместилось): ${JSON.stringify(args.headings.slice(0, 40))}` : "";
  const si = args.subIntents?.length ? `\n- под-интенты пользователей из анализа: ${JSON.stringify(args.subIntents.slice(0, 16))}` : "";
  const paa = args.paa?.length ? `\n- People-Also-Ask из выдачи (приоритет — это РЕАЛЬНЫЕ вопросы): ${JSON.stringify(args.paa.slice(0, 12))}` : "";
  return `Ты — SEO-стратег. Для статьи по теме "${args.keyword}" (язык ${args.language}, регион ${args.country}, цель страницы: ${goal}) собери блок FAQ. Верни СТРОГИЙ JSON без преамбулы и markdown-обёрток.

ПРАВИЛА:
- Ровно ${n} вопросов, на языке ${args.language}, сформулированных так, как их РЕАЛЬНО набирают в поиске (полные вопросительные фразы, а не темы).
- Приоритет: сначала вопросы из People-Also-Ask, затем под-интенты, которые не закрыты основными секциями.
- Для КАЖДОГО заполни answer_guideline (на РУССКОМ — это инструкция копирайтеру): 40-60 слов, какие конкретные сущности, цифры и ориентиры задействовать, чем закончить ответ.
- Вопросы про цену/сроки/гарантию/географию обязательны, если тема их допускает — это самые кликаемые.
- ${NO_FABRICATION}
${heads}${si}${paa}

ВЕРНИ JSON строго по схеме:
{ "faq": [ { "question": "", "answer_guideline": "40-60 слов, конкретно" } ] }`;
}

// ─── Heading localization/styling: translate template headings into the article language ──
// User templates come in English; models keep them verbatim despite instructions. This pass
// returns explicit renames (old → new) that we apply deterministically: headings land in the
// article language, carry keywords naturally, and pick up the narration voice (first-person
// "Mon avis / Ma comparaison" style) the way reference-grade outlines do.
export function buildHeadingLocalizePrompt(args: {
  keyword: string;
  language: string;
  country: string;
  narration?: "first" | "third";
  pageGoal?: "informational" | "commercial" | "mixed";
  h1?: string;
  titleOptions?: string[];
  descriptionOptions?: string[];
  headings: { h_level: string; heading: string }[];
}): string {
  const voice = args.narration === "first"
    ? `\n- ГОЛОС: повествование от ПЕРВОГО лица (экспертный «я»-обзор). H1 и ~30-50% H2 переформулируй в личной форме на языке ${args.language} (примеры для fr: «Mon Avis Complet sur…», «Ma Comparaison des…», «Comment J'Utilise…»; для en: «My Complete Review of…», «How I Use…»). НЕ делай личными служебные секции (FAQ, юридические).`
    : "\n- ГОЛОС: нейтральный/корпоративный — без «я»-формулировок.";
  return `Сегодня ${new Date().toISOString().slice(0, 10)} — если в формулировках уместен год, используй ТОЛЬКО текущий (${new Date().getFullYear()}); НИКОГДА не пиши 2023/2024/2025.\n\nТы — SEO-редактор. Ниже H1 и заголовки секций статьи по теме "${args.keyword}". Статья пишется на языке ${args.language} (регион ${args.country}), но часть заголовков — на другом языке (каркас из шаблона) или звучит шаблонно. ПЕРЕИМЕНУЙ их: естественный язык статьи + поисковые ключи + живые формулировки. Верни СТРОГИЙ JSON без преамбулы и markdown-обёрток.

ПРАВИЛА:
- КАЖДЫЙ заголовок не на языке ${args.language} — ОБЯЗАТЕЛЬНО переведи (естественно, не дословно; сохрани смысл и намерение секции).
- Вплетай ключи: ВЧ — в H1/крупные H2, НЧ-хвосты — в H3. Без переспама и без потери читабельности.${voice}
- Заголовки уже на языке ${args.language} и хорошие — НЕ включай в renames.
- НЕ меняй порядок, НЕ добавляй и НЕ удаляй секции. Одно переименование на заголовок. Без дублей.
- "from" — ТОЧНАЯ текущая формулировка заголовка.

- МЕТА-ТЕГИ: если Title/Description ниже не на языке ${args.language} — перепиши их на языке ${args.language} по правилам выдачи: Title 50-60 символов, главный ключ в начале, бренд в конце через « | »; Description ~150-155 символов, ценность + конкретика + CTA (для коммерческих). Если уже на языке и хороши — верни пустые массивы.

H1 СЕЙЧАС: ${args.h1 || "—"}
TITLE СЕЙЧАС: ${JSON.stringify(args.titleOptions || [])}
DESCRIPTION СЕЙЧАС: ${JSON.stringify(args.descriptionOptions || [])}
ЗАГОЛОВКИ: ${JSON.stringify(args.headings)}

ВЕРНИ JSON строго по схеме:
{ "h1": "новый H1 на языке ${args.language} (или текущий, если он уже хорош)", "title_options": ["", ""], "description_options": ["", ""], "renames": [ { "from": "", "to": "" } ] }`;
}

// ─── Section enrichment (2nd pass): deepen each section's EAV detail in small batches ──
// A single outline call compresses per-section detail when there are 15-30 sections (token
// budget). This pass re-processes sections in batches of ~5 parallel calls, so every section
// gets reference-grade depth: 3-5 role-annotated entities, 4-6 sentence summary, rich
// copywriter notes with a ready-made opening line, 3-5 weighted triplets, format hints.
export function buildSectionEnrichPrompt(args: {
  keyword: string;
  language: string;
  country: string;
  tone?: string;
  persona?: string;
  narration?: "first" | "third";
  pageGoal?: "informational" | "commercial" | "mixed";
  h1?: string;
  globalEntities?: string[];   // outline-level entity names for consistency
  ragFacts?: string;
  sections: any[];             // the batch (full section objects)
}): string {
  const voice = args.narration === "first"
    ? "первое лицо, экспертный «я»-голос (личный опыт)"
    : args.narration === "third" ? "третье лицо, нейтральный корпоративный голос" : "экспертный";
  const goalLine = args.pageGoal === "commercial"
    ? "\n- ЦЕЛЬ СТРАНИЦЫ: КОММЕРЧЕСКАЯ — copywriter_notes ведут читателя к целевому действию (регистрация/бонус/бронирование), подчёркивают выгоды и УТП, но сравнения честные, без обесценивания альтернатив."
    : args.pageGoal === "informational"
    ? "\n- ЦЕЛЬ СТРАНИЦЫ: ИНФОРМАЦИОННАЯ — copywriter_notes справочные и нейтральные, без продаж и CTA; полнота и точность важнее конверсии."
    : args.pageGoal === "mixed"
    ? "\n- ЦЕЛЬ СТРАНИЦЫ: СМЕШАННАЯ — информационная полнота + мягкие конверсионные вставки, CTA только там, где уместен."
    : "";
  const ents = args.globalEntities?.length ? `\n- сущности статьи (используй эти + добавляй релевантные): ${args.globalEntities.slice(0, 25).join(", ")}` : "";
  const rag = args.ragFacts?.trim() ? `\n- ПРОВЕРЕННЫЕ ФАКТЫ ИЗ БАЗЫ ЗНАНИЙ (вплетай конкретику в summary/notes): ${args.ragFacts.trim().slice(0, 2500)}` : "";
  const slim = args.sections.map((s: any) => ({
    h_level: s.h_level, heading: s.heading,
    word_count_total: s.word_count_total, word_count_self: s.word_count_self,
    entities_to_cover: s.entities_to_cover, keywords: s.keywords, summary: s.summary,
    copywriter_notes: s.copywriter_notes, entity_connections: s.entity_connections,
    visual_elements: s.visual_elements,
  }));
  return `Сегодня ${new Date().toISOString().slice(0, 10)} — если в формулировках уместен год, используй ТОЛЬКО текущий (${new Date().getFullYear()}); НИКОГДА не пиши 2023/2024/2025.\n\nТы — SEO-стратег и entity-аналитик. Ниже ${slim.length} секций структуры статьи по теме "${args.keyword}" (язык ${args.language}, регион ${args.country}). Они набросаны СКУДНО. ОБОГАТИ каждую до эталонной детализации, по которой копирайтер напишет идеальную секцию. Верни СТРОГИЙ JSON без преамбулы и markdown-обёрток.

ДЛЯ КАЖДОЙ СЕКЦИИ (ЖЁСТКИЕ ТРЕБОВАНИЯ):
- "entities_to_cover": 3-5 сущностей (для мелких H3 — 2-3), КАЖДАЯ с weight (1-10) и role ("primary — ядро секции" / "secondary — регуляторная валидация" / "secondary — социальное доказательство" / "secondary — контекст рынка" и т.п.). НЕ дублируй один бренд во все секции — добавляй регуляторов, платёжки, типы игр/ставок, лиги, провайдеров, площадки отзывов.
- "keywords": 4-6 ПОЛНЫХ поисковых фраз, УНИКАЛЬНЫХ для этой секции (не повторяй между секциями), на языке ${args.language}.
- "summary": 4-6 предложений — что раскрыть, какая сущность что якорит, какими конкретными фактами/цифрами насытить, чем секция завершается.
- "copywriter_notes": 5-7 предложений в тоне «${args.tone || "нейтральный эксперт"}»${args.persona ? ` (persona: ${args.persona})` : ""}, голос: ${voice}. ОБЯЗАТЕЛЬНО включи: (1) готовое ПЕРВОЕ ПРЕДЛОЖЕНИЕ секции на языке ${args.language} в кавычках, (2) как вплести сущности и их атрибуты, (3) формат подачи — ПО УМОЛЧАНИЮ «связные абзацы»; список/шаги предлагай РЕДКО (максимум в 20% секций, только для процедур: регистрация, пошаговые инструкции, чек-листы), таблицу — только если у секции есть visual_element типа "table", (4) конкретные якоря для региона ${args.country} (лиги, регуляторы, платёжки, известные продукты).
- "entity_connections": 3-5 триплетов { "subject","predicate","object","strength": 1-10 }.
- "visual_elements": суммарно по статье пометь 2-4 САМЫЕ табличные секции (сравнения, цены/бонусы, платёжные методы, характеристики/RTP) элементом { "type":"table", "title":"", "description":"какие колонки и данные" }; у остальных секций — пустой массив. Секцию FAQ НИКОГДА не помечай таблицей — это вопрос-ответ, а не табличные данные, даже если в её summary упоминаются лимиты/бонусы/цифры.
- ЯЗЫКИ (строго): "summary" и "copywriter_notes" — на РУССКОМ (это инструкции копирайтеру); готовое первое предложение внутри notes и все "keywords" — на языке статьи (${args.language}). Не смешивай языки внутри одного поля.
- НЕ МЕНЯЙ: heading, h_level, word_count_total, word_count_self — верни их как есть.${goalLine}
- ${NO_FABRICATION}

ДАНО:
- keyword: ${args.keyword}
- H1 статьи: ${args.h1 || "—"}${ents}${rag}
- СЕКЦИИ (обогати каждую, порядок сохрани): ${JSON.stringify(slim)}

ВЕРНИ JSON строго по схеме: { "sections": [ { "heading":"", "h_level":"", "word_count_total":[0,0], "word_count_self":[0,0], "entities_to_cover":[{"name":"","weight":10,"role":""}], "keywords":[""], "summary":"", "copywriter_notes":"", "entity_connections":[{"subject":"","predicate":"","object":"","strength":10}], "visual_elements":[] } ] }
Количество секций в ответе = ${slim.length}, тот же порядок.`;
}

// ─── Landing wireframe (block-by-block skeleton, no visual design) ──────────────────
// Turns the already-built outline (ТЗ) + optionally the author's own page structure into an
// ordered list of landing-page BLOCKS (hero, USP bar, card lists, reviews, FAQ, CTA…), each with
// concrete, checkable requirements — mirrors the "Wireframe (макет лендинга)" step of the
// reference tool. Runs AFTER buildOutlinePrompt so it can reuse the same entities/keywords/intent.
export const WIREFRAME_BLOCK_TYPES = [
  "HERO_FORM", "USP_BAR", "ITEM_CARD_LIST", "HOW_IT_WORKS", "COMPARISON_TABLE",
  "PRICING_TABLE", "FEATURE_LIST", "GALLERY", "REVIEWS", "TRUST_BADGES", "MAP",
  "FAQ", "TEXT_BLOCK", "CTA_BANNER",
] as const;

export function buildWireframePrompt(args: {
  keyword: string;
  language: string;
  country: string;
  outline: any;
  structureMode?: "serp" | "my_1to1" | "hybrid" | "seo_block";
  myStructure?: { level: string; text: string; words: number }[];
  targetWordCount?: number;
}): string {
  const meta = args.outline?.meta || {};
  const sections = Array.isArray(args.outline?.sections) ? args.outline.sections : [];
  const slimSections = sections.map((s: any) => ({
    h_level: s.h_level, heading: s.heading, summary: s.summary,
    entities: (s.entities_to_cover || []).map((e: any) => typeof e === "string" ? e : e.name),
    keywords: s.keywords,
  }));
  const mode = args.structureMode || "serp";
  const modeBlock = mode === "my_1to1" && args.myStructure?.length
    ? `\n\nРЕЖИМ: ПО МОЕЙ СТРУКТУРЕ (1:1). У пользователя уже есть готовая страница со СВОИМИ заголовками — используй ИХ порядок и формулировки ДОСЛОВНО как каркас wireframe-блоков (не придумывай новые заголовки, не переставляй и не выкидывай). Для каждого заголовка подбери наиболее подходящий тип блока из каталога и требования, наполненные фактурой из ТЗ (сущности/ключи ниже). "words" ориентир для секции указан у пользователя — держись его при формулировке requirements по объёму.\nМОЯ СТРУКТУРА СТРАНИЦЫ: ${JSON.stringify(args.myStructure)}`
    : mode === "hybrid" && args.myStructure?.length
    ? `\n\nРЕЖИМ: ВЫДАЧА + МОЯ СТРАНИЦА (гибрид). Построй wireframe на основе анализа ТОП-конкурентов (ниже), но учти мою существующую структуру как ДОПОЛНИТЕЛЬНЫЙ контекст — можешь заимствовать из неё удачные секции/формулировки, если они усиливают структуру, без обязательства повторять её дословно.\nМОЯ СУЩЕСТВУЮЩАЯ СТРАНИЦА (контекст): ${JSON.stringify(args.myStructure)}`
    : mode === "seo_block"
    ? `\n\nРЕЖИМ: SEO-БЛОК («портянка» вниз, для интернет-магазинов/каталогов). После основных конверсионных блоков (hero/usp/карточки товаров) добавь РАЗВЁРНУТЫЙ SEO-текстовый блок(и) внизу страницы (TEXT_BLOCK) — информационное наполнение под все sub-intents и FAQ, максимально покрывающее ключи и сущности из ТЗ, ДО финального CTA/футера.`
    : `\n\nРЕЖИМ: ПО ВЫДАЧЕ. Построй wireframe с нуля на основе анализа конкурентов и ТЗ ниже — типовая для тематики и intent структура блоков.`;

  const dominant = meta.dominant_intent || "";
  const twc = args.targetWordCount ? `\n- ориентир общего объёма текста на странице: ~${args.targetWordCount} слов` : "";

  return `Ты — UX/CRO-стратег лендингов. По ТЗ статьи ниже построй WIREFRAME лендинга — упорядоченный список БЛОКОВ секций (без визуального дизайна, просто структура и требования к содержимому каждого блока), максимально конверсионный для intent="${dominant || "mixed"}" и пригодный сразу отдать дизайнеру/верстальщику. Верни СТРОГИЙ JSON без преамбулы и без markdown-обёрток.

КАТАЛОГ ТИПОВ БЛОКОВ (используй ТОЛЬКО эти значения для "type"): ${WIREFRAME_BLOCK_TYPES.join(", ")}.
- HERO_FORM: главный экран — заголовок H1, подзаголовок/подводка, CTA-кнопка (и/или форма заявки).
- USP_BAR: полоса ключевых преимуществ/УТП.
- ITEM_CARD_LIST: карточки товаров/услуг/тарифов/авто и т.п.
- HOW_IT_WORKS: этапы процесса/использования услуги.
- COMPARISON_TABLE: сравнение вариантов/тарифов/конкурентов.
- PRICING_TABLE: таблица цен/тарифов.
- FEATURE_LIST: колонки преимуществ (иконка + заголовок + описание).
- GALLERY: фото/видео-галерея.
- REVIEWS: отзывы/рейтинги/соц. доказательство.
- TRUST_BADGES: сертификаты/лицензии/логотипы партнёров/платёжные системы.
- MAP: карта/зона покрытия/маршрут.
- FAQ: блок вопрос-ответ.
- TEXT_BLOCK: развёрнутый SEO-текст (информационный, не конверсионный).
- CTA_BANNER: финальный призыв к действию перед футером.

ПРАВИЛА:
- 8-14 блоков для обычного лендинга, ДО 20 для режима SEO-блок. Порядок — логичный путь пользователя: hero → доверие/УТП → предложение/карточки → как это работает → сравнение/цены (если уместно) → отзывы → FAQ → CTA.
- Для КАЖДОГО блока: "heading" — конкретный заголовок ЭТОГО блока (не общее название типа), на языке ${args.language}, с ключом, где уместно.
- "requirements" (2-4 шт. на блок) — КОНКРЕТНЫЕ, проверяемые пункты содержимого (например "≥3 карточки типов авто", "у каждой карточки: фото, название, вместимость, цена от", "агрегированный рейтинг с известной площадки (Google/Trustpilot)", "≥3 именных отзыва с деталями поездки"). НЕ общие фразы вроде «сделать хорошо».
- Используй сущности/ключи/факты из ТЗ ниже, чтобы requirements были предметными (конкретные типы авто/тарифов/сущности, а не абстракции).
- source_section (опционально) — heading соответствующей секции из ТЗ, если блок её раскрывает.
- НЕ выдумывай лицензий/отзывов/цифр — требования должны описывать ЧТО показать, а не выдуманные значения.${modeBlock}

ДАНО:
- keyword: ${args.keyword}
- язык/страна: ${args.language}/${args.country}
- доминирующий интент: ${dominant || "не определён"}${twc}
- ТЗ (сокращённо — заголовки/summary/сущности/ключи по секциям): ${JSON.stringify(slimSections).slice(0, 9000)}

ВЕРНИ JSON строго по схеме (только JSON):
{ "blocks": [ { "type": "HERO_FORM", "heading": "", "requirements": ["",""], "source_section": "" } ] }`;
}

// ─── Outline fact-scrub: correct baked-in wrong/fabricated specifics before the text is written ──
// Runs right after outline generation. Uses the model's reliable knowledge to fix concrete values
// (wrong screen size, fabricated colors, wrong price/date/edition/game names). Returns find→replace
// pairs that are applied over the outline's string VALUES only (structure/keys/entities untouched).
export function buildFactScrubPrompt(args: { outline: any; keyword: string; country?: string }): string {
  return `Ты — фактчекер-редактор с надёжными знаниями о предмете. Ниже JSON-структура статьи (outline) по теме "${args.keyword}"${args.country ? `, регион ${args.country}` : ""}. Найди КОНКРЕТНЫЕ фактические значения, которые ВЫГЛЯДЯТ ОШИБОЧНЫМИ или ВЫДУМАННЫМИ: неверные характеристики (диагональ экрана, объём памяти, чип, разрешение, частота), неверные/выдуманные цены и MSRP, неверные даты, неточные названия моделей/изданий/игр, выдуманные цвета/комплектации/SKU.

Для каждой такой ошибки верни пару find→replace:
- "find": ТОЧНАЯ подстрока, как она буквально встречается в значениях JSON (например "8-inch LCD").
- "replace": исправленное РЕАЛЬНОЕ значение, если ты в нём уверен (например "7.9-inch LCD"); ЛИБО обобщённая формулировка без выдуманной конкретики, если точного значения не знаешь (например для выдуманных цветов — "various Joy-Con 2 color options").

ПРАВИЛА:
- Меняй ТОЛЬКО явно ошибочное/выдуманное. Достоверно верные значения НЕ трогай.
- НЕ меняй структуру, ключи, заголовки секций, имена сущностей — только фактические ЗНАЧЕНИЯ внутри строк.
- "find" должен встречаться в JSON буквально; не выдумывай несуществующих подстрок.
- Будь осторожен: лучше обобщить сомнительное, чем заменить на другое сомнительное.
- Если явных ошибок нет — верни пустой список.

Верни СТРОГИЙ JSON без обёрток: { "corrections": [ { "find": "", "replace": "" } ] }

OUTLINE JSON:
${JSON.stringify(args.outline).slice(0, 18000)}`;
}

// ─── Auto fact-clean: verify a finished article against the facts bank, then fix in one pass ──────
// Runs right after text generation. The facts bank = the consolidated facts extracted from the top
// sources the article was built on, so this is a CONFIRM-and-correct pass, not a fresh rewrite.
export function buildAutoFactCleanPrompt(args: { article: string; factsBank: string; language: string }): string {
  return `Ты — аккуратный фактчек-редактор. Ниже ГОТОВАЯ СТАТЬЯ (Markdown) и БАНК ФАКТОВ — факты, извлечённые из топ-источников выдачи. Банк НЕПОЛНЫЙ (он не покрывает все реальные бренды/модели/цены — особенно для другого региона). Поэтому «нет в банке» НИКОГДА не значит «неправда».

Сделай МИНИМАЛЬНУЮ правку, СОХРАНИВ объём, все секции, бренды и стиль:
1. Меняй ТОЛЬКО то, что ПРЯМО ПРОТИВОРЕЧИТ банку (число/цена/спека отличается) — исправь по банку.
2. Убирай ТОЛЬКО то, что ЯВНО невозможно/выдумано (несуществующая модель, абсурдная цифра).
3. Всё остальное — реальные бренды и модели (SpringWell, Fleck и т.п.), типичные характеристики, диапазоны цен, общеизвестные факты — ОСТАВЬ КАК ЕСТЬ, даже если их нет в банке. НЕ обобщай и НЕ вырезай их.
4. СИНХРОНИЗАЦИЯ ЧИСЕЛ: если значение есть и в прозе, и в таблице/списке — приведи к ОДНОМУ.
КРИТИЧНО: НЕ сокращай статью (объём должен остаться примерно прежним, ±5%), НЕ удаляй секции/абзацы, НЕ трогай заголовки и их порядок, сохрани мета-блок в начале. Никаких маркеров [ПРОВЕРИТЬ] и плейсхолдеров. Язык — ${args.language}.
Верни ТОЛЬКО готовый Markdown статьи целиком, без преамбулы.

БАНК ФАКТОВ:
${args.factsBank.slice(0, 9000)}

СТАТЬЯ:
${args.article}`;
}

// ─── Content Analysis (comprehensive, EAV) — drives Dashboard / Guideline / Gaps / Constructor ──
// Compares the target page against scraped top competitors and returns a rich JSON spec.
export function buildAnalysisPrompt(args: {
  keyword: string;
  targetPage: any;
  competitors: CompetitorInput[];
  language?: string;
  country?: string;
  policy?: EditorialPolicy;
}): string {
  const policyBlock = args.policy ? renderPolicy(args.policy) + "\n\n" : "";
  const loc = [args.language, args.country].filter(Boolean).join("/");
  return `${policyBlock}Ты — SEO/GEO entity-аналитик. Сравни ЦЕЛЕВУЮ страницу с топ-конкурентами из выдачи и построй ПОЛНЫЙ план улучшения контента в EAV-модели (Entity-Attribute-Value), чтобы целевая страница стала полнее и авторитетнее конкурентов и попадала в цитирование ИИ-движков (ChatGPT/Perplexity/Yandex). Верни СТРОГИЙ JSON без преамбулы и без markdown-обёрток.

ЧТО СДЕЛАТЬ:
1. Извлеки ключевые СУЩНОСТИ темы из конкурентов (товары, услуги, места, виды транспорта, объекты). Для каждой определи: покрыта ли она на целевой странице (mentions), сколько у целевой связей-триплетов vs медиана конкурентов, статус покрытия (well / underdeveloped / missing), важность (high/medium/low) и семантическую близость к теме (0..1).
2. Составь приоритизированные РЕКОМЕНДАЦИИ (sub-intents) — секции, которые надо ДОБАВИТЬ (new_h2/new_h3), РАСШИРИТЬ (expand), УСИЛИТЬ (enhance) или СОКРАТИТЬ (reduce). Для каждой: статус, NEW/EXISTING, точное место вставки (placement по заголовкам конкурентов/целевой), целевой объём (из/в словах), заметки копирайтеру, ключи, и сущности с обязательными триплетами (subject → predicate → object) и инструкцией «как раскрыть».
3. Найди КОНКУРЕНТНЫЕ ГЭПЫ — темы/секции/таблицы, которые есть у конкурентов, но нет у нас. Для каждого: рекомендация add/skip/merge/expand, причина (со ссылкой на конкретных конкурентов по URL) и потенциальные сущности с триплетами.

ПРИНЦИПЫ: front-load факты (цена/время/расстояние); для коммерческих тем — честное сравнение ВСЕХ вариантов; НЕ выдумывай лицензии/отзывы/опыт; приоритеты в долях 0..1.

ДАНО:
- keyword: ${args.keyword}${loc ? `\n- язык/страна: ${loc}` : ""}
- ЦЕЛЕВАЯ СТРАНИЦА: ${JSON.stringify(args.targetPage)}
- КОНКУРЕНТЫ (топ выдачи, со структурой): ${JSON.stringify(args.competitors)}

ВЕРНИ JSON строго по схеме (только JSON, без markdown):
{
  "main_keyword": "",
  "target_url": "",
  "summary": { "total_entities": 0, "entities_found": 0, "entities_missing": 0, "coverage_percent": 0, "coverage_label": "underdeveloped|developing|strong", "content_gaps": 0, "recommendations": 0, "sub_intents": 0 },
  "entities": [ { "id": "E_001", "name": "", "kind": "core|secondary", "coverage": "well|underdeveloped|missing", "mentions": 0, "triplets_current": 0, "triplets_competitor_median": 0, "similarity": 0.0, "importance": "high|medium|low", "required_triplets": 0 } ],
  "recommendations": [ {
    "id": "SI_001", "title": "", "priority": 0.0, "relevance": 0.0,
    "type": "new_h2|new_h3|expand|enhance|reduce", "section": "NEW|EXISTING", "placement": "",
    "words_from": 0, "words_to": 0,
    "copywriter_notes": "",
    "keywords": [""],
    "entities": [ { "name": "", "role": "primary|supporting", "required_triplets": ["Subject → predicate → Object"], "how_to_cover": "" } ]
  } ],
  "competitor_gaps": [ {
    "id": "GAP_001", "title": "", "recommendation": "add|skip|merge|expand", "reason": "",
    "found_in_competitors": ["https://..."],
    "potential_entities": [ { "id": "E_016", "name": "", "triplets": ["Subject → predicate → Object"] } ]
  } ],
  "excluded": [ { "name": "", "kind": "entity|section", "reason": "low_priority|irrelevant" } ]
}`;
}

// ─── Article text generation prompt (spec §9.3) ─────────────────────────────────
export function buildTextPrompt(args: {
  outlineJson: any;
  policy?: EditorialPolicy;
  tone: string;
  language: string;
  custom?: string;
  promptType?: "service" | "custom";
  sources?: { title: string; snippet: string; url: string; domain: string }[];
  sourceMode?: "off" | "facts" | "cited";
  includeToc?: boolean;
  ragFacts?: string;
  bannedWords?: string[];
}): string {
  // Tone folded into the policy block (single source) when a policy exists; otherwise a header line.
  const policyBlock = args.policy ? renderPolicy(args.policy, args.tone) + "\n\n" : "";
  const toneHeader = args.policy ? "" : `Тон повествования: ${args.tone}\n`;
  const narr = (args.outlineJson as any)?.meta?.narration;
  const narrLine = narr === "first" ? "Лицо: ПЕРВОЕ — экспертный «я»-голос, личный опыт.\n"
    : narr === "third" ? "Лицо: ТРЕТЬЕ — корпоративный нейтральный голос, без «я».\n" : "";
  const country = (args.outlineJson as any)?.meta?.country;
  const regionLine = country ? `Регион: ${country}. Цены/суммы — в валюте региона (${currencyHint(country)}), НЕ в USD по умолчанию; ритейлеры и реалии — релевантные региону (без магазинов, которых там нет).\n` : "";
  const sRules = (args.outlineJson as any)?.meta?.structureRules;
  const structRulesLine = sRules ? `Правила структуры от пользователя (соблюдай): ${String(sRules).slice(0, 1500)}\n` : "";
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const dateLine = `Сегодня ${today}. Если нужен год — используй ТЕКУЩИЙ (${year}); никогда не пиши устаревшие годы (2023/2024) и не выдумывай год.\n`;
  const customLine = args.custom ? `Дополнительная инструкция автора (учесть обязательно): ${args.custom}\n` : "";
  const twcNum = Number((args.outlineJson as any)?.meta?.target_word_count) || 0;
  const twcLine = twcNum ? `ЦЕЛЕВОЙ ОБЪЁМ СТАТЬИ: ~${twcNum} слов (±15%) — это сумма word_count секций. word_count КАЖДОЙ секции — жёсткий ДИАПАЗОН: не короче нижней границы и НЕ ДЛИННЕЕ верхней. Перебор объёма — такой же брак, как недобор: не лей воду, не повторяй одну мысль в разных секциях, не раздувай списки. Каждое предложение должно нести факт или пользу.\n` : "";

  // Carry the chosen meta tags (title/description/slug) from the outline into the article head,
  // so the generated text ships with publish-ready SEO meta instead of dropping them.
  const m = (args.outlineJson as any)?.meta || {};
  const pick = (v: any) => Array.isArray(v) ? (v.find((x: any) => x && String(x).trim()) || "") : (v || "");
  const metaTitle = pick(m.title_options) || pick(m.title);
  const metaDesc = pick(m.description_options) || pick(m.description);
  const metaSlug = pick(m.slug_options) || pick(m.slug);
  const metaH1 = pick(m.h1);
  const h1Line = metaH1 ? `\nЗаголовок H1 статьи: «${metaH1}» — используй ИМЕННО его как H1 (он ОТЛИЧАЕТСЯ от Title: H1 — для читателя, Title — для выдачи). НЕ копируй Title в H1.` : "";
  const metaBlock = (metaTitle || metaDesc || metaSlug)
    ? `\nМЕТА-ТЕГИ (вставь их В САМОЕ НАЧАЛО статьи отдельным блоком ДО заголовка H1, ровно в таком виде, заполнив значения):\n\`\`\`\nTitle: ${metaTitle}\nMeta Description: ${metaDesc}\nURL Slug: ${metaSlug}\n\`\`\`\nЗатем с новой строки начни саму статью с H1.${h1Line} Title должен быть 50–60 символов, Meta Description ~155, Slug — латиницей в нижнем регистре через дефисы. Если значение пустое — допиши подходящее по правилам.\n`
    : "";

  // Knowledge-base (RAG) facts block — verified entity attributes, no links needed.
  const ragTextBlock = args.ragFacts?.trim()
    ? `\nБАЗА ЗНАНИЙ (ПРОВЕРЕННЫЕ ФАКТЫ О СУЩНОСТЯХ): используй эти атрибуты как достоверные данные (подавай как собственную проверенную информацию, БЕЗ ссылок на базу). Не противоречь им и не подменяй выдуманными значениями.\n${args.ragFacts.trim().slice(0, 6000)}\n`
    : "";

  // Real-source grounding (retrieval-augmented). Two modes:
  //  - facts: use real numbers but NEVER name/link competitors (for commercial/own-brand pages)
  //  - cited: use real numbers and add [text](url) links to sources (for informational/affiliate)
  const srcs = args.sources || [];
  let sourcesBlock = "";
  if (srcs.length && (args.sourceMode === "facts" || args.sourceMode === "cited")) {
    const list = srcs.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet} (${s.url})`).join("\n");
    if (args.sourceMode === "facts") {
      sourcesBlock = `\nДАННЫЕ ИЗ ИСТОЧНИКОВ (используй для КОНКРЕТНЫХ цифр: цены, время, расстояния, расписания):\n${list}\nПРАВИЛО ПО ИСТОЧНИКАМ: бери реальные цифры из данных выше, НО НЕ упоминай названия компаний/конкурентов и НЕ ставь на них ссылки. Подавай цифры как собственную проверенную информацию. Если данные расходятся — давай диапазон.\n`;
    } else {
      sourcesBlock = `\nИСТОЧНИКИ (используй реальные цифры; где уместно — ставь ссылку в формате [текст](url) на источник):\n${list}\nПРАВИЛО: используй конкретные цифры из источников; не выдумывай URL — бери только из списка выше. РАЗМЕЩЕНИЕ ССЫЛОК (по методике Rush): не ставь ссылки рядом — минимум ~1000 символов (≈150 слов) между двумя ссылками; распределяй их по тексту, не более одной на 1-2 абзаца, не кучкуй.\n`;
    }
  }

  // Custom prompt type: the author's instruction drives the writing; service template is minimal.
  if (args.promptType === "custom" && args.custom) {
    return `${policyBlock}${toneHeader}${narrLine}${regionLine}${structRulesLine}Язык вывода: ${args.language}
${dateLine}${twcLine}${NO_FABRICATION}
${metaBlock}ГЛАВНАЯ ИНСТРУКЦИЯ АВТОРА:
${args.custom}
${sourcesBlock}${ragTextBlock}${bannedWordsBlock(args.bannedWords)}
Напиши статью по структуре ниже, следуя инструкции автора выше. Соблюдай word_count секций.
ЖЁСТКИЕ ПРАВИЛА: ровно один H1 (из Title), и СРАЗУ после него — первый H2, БЕЗ вводного абзаца между H1 и первым H2; весь текст только под заголовками H2/H3. Где нет реальных данных — не выдумывай лицензии/регалии/отзывы, ставь плейсхолдер [ЗАПОЛНИТЬ ВРУЧНУЮ: ...]; секции needs_real_experience=true — оставь [ВСТАВЬ РЕАЛЬНЫЙ ОПЫТ]; соблюдай ограничения политики.
Верни готовый текст в Markdown.

СТРУКТУРА (JSON):
${JSON.stringify(args.outlineJson)}`;
  }

  return `${policyBlock}${toneHeader}${narrLine}${regionLine}${structRulesLine}Язык вывода: ${args.language}
${dateLine}${twcLine}${customLine}${metaBlock}${sourcesBlock}${ragTextBlock}
Напиши статью строго по структуре ниже. ОХВАТИ КАЖДУЮ секцию структуры (НЕ пропускай ни одного H2/H3). Объём каждой секции — строго в её word_count-диапазоне: не короче и НЕ длиннее. Используй summary, keywords, entities_to_cover и copywriter_notes как ориентир. Естественно вплетай сущности и ключи. БЕЗ ВОДЫ: не повторяй мысли между секциями, не пиши обобщённых абзацев-филлеров («важно отметить», «стоит подчеркнуть») — только конкретика и польза.
- КОНКРЕТИКА ИЗ СТРУКТУРЫ (КРИТИЧНО): все конкретные бренды, модели, ритейлеры, цифры и цены, что есть в summary, copywriter_notes и entities_to_cover, ОБЯЗАТЕЛЬНО перенеси в текст ДОСЛОВНО (например «RIVERSOFT 15 — €690», «Water-filters.gr — от €610», «Pentair Foleo»). НЕ заменяй их общими словами («разные модели», «местные магазины») — именно конкретные названия и цены делают статью полезной и цитируемой в ИИ-поиске. Если у секции есть visual_element-таблица (Бренд/Модель/Цена и т.п.) — построй её РЕАЛЬНЫМИ моделями из структуры, а не пустыми/обобщёнными строками.
- ПРИОРИТЕТ ПРИ ОГРАНИЧЕННОМ ОБЪЁМЕ: если целевой объём небольшой и всё не помещается — режь ВОДУ и общие фразы, а конкретику (бренды, модели, цены, цифры) СОХРАНЯЙ. Лучше короче, но с реальными названиями и ценами, чем длинно и общо.

ЖЁСТКИЕ ПРАВИЛА:
- СТРУКТУРА И ИЕРАРХИЯ (КРИТИЧНО): ровно ОДИН H1 — бери его из «Заголовок H1 статьи» (meta.h1), если задан; он ОТЛИЧАЕТСЯ от Title (H1 — цепляющий, для читателя, с ВЧ-ключом; Title — для выдачи), но использует ТЕКУЩИЙ год (не год выхода). После H1 НЕ пиши вводный абзац/лид${args.includeToc ? " (кроме блока оглавления — см. ниже)" : " — сразу идёт первый H2, ничего между ними"}. Весь текст статьи — ТОЛЬКО под заголовками H2/H3 (никаких «висячих» абзацев под H1). Вступление, если нужно, помещай ПОД первым H2 (он обычно и есть вводная/обзорная секция из структуры).${args.includeToc ? `
- ОГЛАВЛЕНИЕ: сразу после H1 добавь блок оглавления как HTML-DIV (НЕ заголовком H2/H3, чтобы не ломать SEO-иерархию): \`<div class="toc"><strong>[СЛОВО «Оглавление/Contents» ПЕРЕВЕДЁННОЕ НА ЯЗЫК ${args.language}]</strong><ul><li><a href="#anchor">Раздел</a></li>...</ul></div>\`. Слово-заголовок ОБЯЗАТЕЛЬНО на языке статьи ${args.language} — переведи, не копируй чужой язык (примеры перевода этого слова: en="Contents", ru="Содержание", uk="Зміст", fr="Sommaire", es="Índice", de="Inhalt", it="Indice" — и так далее для ЛЮБОГО языка статьи; если статья не на русском, слово «Содержание» в ней недопустимо). Пункты — ссылки на разделы H2; anchor = заголовок в нижнем регистре, пробелы→дефисы, без пунктуации. Это ЕДИНСТВЕННОЕ, что между H1 и первым H2. Используй именно <div>, без markdown-заголовка для оглавления.` : ""} КАЖДАЯ секция структуры обязана стать заголовком РОВНО своего уровня: h_level=H2 → «## », H3 → «### », H4 → «#### ». НЕ повышай, не понижай, не объединяй, не пропускай и не переставляй заголовки; НЕ превращай заголовок секции в обычный абзац и НЕ сливай первую секцию с H1. Порядок секций — как в структуре.
- FAQ (ОБЯЗАТЕЛЬНО, если в структуре есть массив faq): отрендери его отдельной секцией в конце статьи — заголовок «## FAQ» (или эквивалент на языке вывода), затем КАЖДЫЙ вопрос как «### Вопрос», под ним ответ по answer_guideline. НЕ пропускай FAQ и не сворачивай в один абзац.
- ГОД И ДАТЫ: статья публикуется СЕГОДНЯ (${year}). В заголовках, «лучшие предложения/цены ${year}», «купить в ${year}» используй ТЕКУЩИЙ год ${year}. Год выхода продукта — это исторический факт, его можно упомянуть в тексте (например «вышла в 2025»), но НЕ подменяй им текущий год в H1/заголовках/слогане.
- ЯЗЫК И ПИСЬМЕННОСТЬ: пиши СТРОГО на языке вывода (${args.language}) и его алфавите. НЕ вставляй символы других письменностей — китайские/японские/корейские иероглифы, кану, хангыль и т.п. Если нужен иностранный термин — передай его на языке вывода или транслитерацией, без оригинальных иероглифов.
- КЛЮЧЕВЫЕ СЛОВА (по методике Rush): естественно вплетай ключи и их синонимы/словоформы РАВНОМЕРНО по тексту, чуть плотнее в первой части статьи. Без переспама (ключи не должны мешать чтению). Ключ из заголовка секции и связанные запросы используй в первом-втором абзаце секции. Главный ключ — обязательно в H1, первом абзаце и заключении.
- БАЛАНС ПОДАЧИ (КРИТИЧНО): основа статьи — СВЯЗНЫЕ АБЗАЦЫ по 2-4 предложения, а НЕ списки. Списки — точечно: не более ОДНОГО списка на секцию и не более ~25% объёма статьи суммарно. В каждой секции сначала минимум 2 полноценных абзаца прозы, и только потом (если действительно уместно) список. НЕ превращай абзацы в маркированные обрывки — за сплошные списки статья считается браком.
- ТАБЛИЦЫ (ОБЯЗАТЕЛЬНО): КАЖДЫЙ visual_element типа "table" из структуры отрендери НАСТОЯЩЕЙ markdown-таблицей (| колонка | колонка |) с реальными данными из структуры/источников/базы знаний, 3-6 строк. Если в структуре таблиц не задано — добавь МИНИМУМ 2 уместные таблицы сам (например: карточка-паспорт предмета «Параметр | Значение», сравнение вариантов/бонусов/тарифов, методы платежей со сроками и лимитами). Таблицы с конкретикой резко повышают цитируемость в ИИ-поиске — статья без единой таблицы недопустима.
- Ключевые цифры и термины выделяй жирным умеренно (не каждое второе слово).
- ${NO_FABRICATION}
- Дополнять текст реальными общеизвестными фактами о предмете (точные характеристики, точные названия моделей/игр, известные цены/даты) — ПРИВЕТСТВУЕТСЯ для полноты и точности, даже если их нет в структуре. Нельзя добавлять лишь то, в чём не уверен или что может не существовать (выдуманные модели/спеки/цены/даты, приблизительные названия). Сомнительную конкретику обобщай, не детализируй выдуманным и не строй таблицы на выдуманных данных.
- ПРИОРИТЕТ РЕАЛЬНОГО ФАКТА: если конкретное значение в структуре (диагональ экрана, размер, спека, цвет, название) ЯВНО противоречит достоверно известному реальному факту — используй РЕАЛЬНОЕ значение, а ошибочное из структуры НЕ копируй. Если не уверен в реальном значении — обобщи, но не тиражируй явную ошибку структуры.
- Где НЕТ реальных данных из источников — НЕ выдумывай лицензии, сертификаты, регалии, отзывы, цифры. Ставь плейсхолдер вида [ЗАПОЛНИТЬ ВРУЧНУЮ: ...].
- Секции с needs_real_experience=true: НЕ сочиняй личный опыт. Оставь [ВСТАВЬ РЕАЛЬНЫЙ ОПЫТ].
- Соблюдай ограничения из политики (banned_words, banned_topics, compliance).
${bannedWordsBlock(args.bannedWords)}
Верни готовый текст в Markdown.

СТРУКТУРА (JSON):
${JSON.stringify(args.outlineJson)}`;
}

// ─── Chunked article writing: one call writes 3-5 sections, not the whole article ─────
// A single 30-section prompt degrades mid-generation (prose turns into lists, tables get
// invented values). Writing in small chunks keeps every section at first-page quality.
export function buildSectionTextPrompt(args: {
  keyword: string;
  language: string;
  country?: string;
  tone: string;
  narration?: "first" | "third";
  h1?: string;
  allHeadings: { h_level: string; heading: string }[]; // full article map for context
  sections: any[];        // the chunk to write (full specs)
  faq?: { question: string; answer_guideline?: string }[]; // present only for the last chunk
  ragFacts?: string;
  sources?: { title: string; snippet: string; url: string; domain: string }[];
  sourceMode?: "off" | "facts" | "cited";
  isVerdictChunk?: boolean; // allow one expert blockquote here
  chunkBudget?: [number, number]; // summed word range of this chunk's sections
  bannedWords?: string[];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const narr = args.narration === "first" ? "ПЕРВОЕ лицо — экспертный «я»-голос (личный опыт)"
    : args.narration === "third" ? "ТРЕТЬЕ лицо — нейтральный корпоративный голос" : "экспертный голос";
  const rag = args.ragFacts?.trim() ? `\nБАЗА ЗНАНИЙ (проверенные факты — используй как достоверные, без ссылок):\n${args.ragFacts.trim().slice(0, 2500)}\n` : "";
  const srcs = (args.sources || []).slice(0, 10);
  const srcBlock = srcs.length && args.sourceMode !== "off"
    ? `\nДАННЫЕ ИЗ ИСТОЧНИКОВ (главный резервуар конкретики — цифры, суммы, сроки, названия${args.sourceMode === "cited" ? "; можно 1-2 ссылки [текст](url) на источники из списка" : "; БЕЗ ссылок и упоминаний конкурентов"}):\n${srcs.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet.slice(0, 700)} (${s.url})`).join("\n")}\n`
    : "";
  const faqBlock = args.faq?.length
    ? `\nПОСЛЕ последней секции ОБЯЗАТЕЛЬНО добавь секцию «## FAQ» со ВСЕМИ ${args.faq.length} вопросами: каждый — «### Вопрос», под ним ответ 40-60 слов по answer_guideline. ВАЖНО: FAQ НЕ входит в суммарный лимит секций — это дополнительные ~${args.faq.length * 50} слов сверх него; пропуск даже одного вопроса — брак.\n${JSON.stringify(args.faq)}\n`
    : "";
  const quote = args.isVerdictChunk
    ? "\n- Можно ОДНУ цитату-блок (строка с «> ») с личным экспертным выводом — только в секции вердикта/итога."
    : "\n- НЕ используй цитаты-блоки (>) в этих секциях.";
  return `Ты пишешь ФРАГМЕНТ большой статьи по теме "${args.keyword}" (язык ${args.language}${args.country ? `, регион ${args.country}` : ""}). Сегодня ${today} — используй текущий год (${year}), не устаревшие.
Тон: ${args.tone}. Лицо: ${narr}.

ПОЛНАЯ КАРТА СТАТЬИ (для понимания контекста — эти секции пишут ОТДЕЛЬНО, их содержимое НЕ дублируй и НЕ анонсируй):
${args.allHeadings.map(h => `${h.h_level}: ${h.heading}`).join("\n")}

ТВОЯ ЗАДАЧА: напиши ТОЛЬКО следующие секции (по их спецификациям ниже), в заданном порядке.

ЖЁСТКИЕ ПРАВИЛА:
- Каждая секция начинается заголовком РОВНО своего уровня: H2 → «## », H3 → «### ». Формулировки заголовков — ДОСЛОВНО из спеки. Никакого H1, мета-тегов и оглавления — они собираются отдельно.
- ОБЪЁМ секции — строго в её word_count-диапазоне: не короче и не длиннее. Это объём ИМЕННО этой секции (для H2 — только его вступление, БЕЗ подсекций: у каждого H3 свой word_count). Без воды и повторов.${args.chunkBudget ? `\n- СУММАРНЫЙ ЛИМИТ этого задания: ${args.chunkBudget[0]}-${args.chunkBudget[1]} слов на ВСЕ секции вместе. Верхняя граница — жёсткий потолок: перед сдачей мысленно посчитай объём и ужми, если вылез.` : ""}
- ПОДАЧА (ПРИОРИТЕТ НАД copywriter_notes): основа — связные абзацы по 2-4 предложения. Максимум ОДИН список на ВСЁ задание, и только в перечислительной секции (шаги регистрации → нумерованный; условия бонуса, каналы поддержки, варианты игр/ставок → маркированный). Список — ФАКТОВЫЙ: 4-6 пунктов, каждый пункт вида «Название : конкретное значение» («Chat en direct : 10h-23h, ответ ~30 сек»). Списки-рассуждения запрещены — перечисления без данных оформляй прозой («доступны X, Y и Z»). Если copywriter_notes предлагают больше списков — ИГНОРИРУЙ: содержание из notes, формат отсюда.
- ТАБЛИЦЫ: ТОЛЬКО если у секции есть visual_element типа "table" — тогда одна markdown-таблица, 3-6 строк. Значения — ТОЛЬКО из спеки секции, базы знаний или источников; НЕ создавай колонок с выдуманными оценками (проценты, маржи, «оценочные» диапазоны). Нет данных для колонки — нет колонки.${quote}
- ПЛОТНОСТЬ ФАКТОВ (КРИТИЧНО — главный критерий качества): минимум КАЖДОЕ ВТОРОЕ предложение содержит конкретику — число, сумму, срок, процент, название модели/провайдера/лиги/платёжки. Пиши «ответ в чате за ~30 секунд с 10:00 до 23:00», а не «быстрая и отзывчивая поддержка». Предложение без факта — кандидат на удаление. Конкретику бери из summary/copywriter_notes/entities секции, базы знаний и источников — переноси ДОСЛОВНО. Если точного значения нигде нет — НЕ выдумывай, но и не пиши пустое обобщение: возьми другой реальный факт из материалов. Ключи из keywords вплетай в первые абзацы секции.
- ПОДТЕМЫ: если у секции есть "subtopics" — раскрой КАЖДУЮ подтему 1-2 абзацами ВНУТРИ секции, БЕЗ отдельного заголовка (это редакторское решение: подтема покрывается прозой, её ключи вплетаются в эти абзацы).
- ${NO_FABRICATION}
- Язык — строго ${args.language}, без вкраплений других письменностей.
${bannedWordsBlock(args.bannedWords)}${rag}${srcBlock}${faqBlock}
СЕКЦИИ ДЛЯ НАПИСАНИЯ (JSON-спеки):
${JSON.stringify(args.sections)}

Верни ТОЛЬКО markdown этих секций (начиная с первого заголовка), без преамбулы и без \`\`\`-обёрток.`;
}

// ─── Text expansion pass: bring an under-length article up to its target volume ──────
// Models routinely undershoot the word budget. This pass takes the finished article and
// expands THIN sections toward their budgets with substance (facts, examples, prose) —
// never fluff, never touching structure/headings/tables that already exist.
export function buildTextExpandPrompt(args: { article: string; targetWords: number; currentWords: number; language: string }): string {
  return `Ты — редактор-эксперт. Ниже ГОТОВАЯ СТАТЬЯ (Markdown) объёмом ~${args.currentWords} слов при целевом объёме ~${args.targetWords} слов (недобор ${Math.max(0, args.targetWords - args.currentWords)} слов). РАСШИРЬ её до целевого объёма, сохранив ВСЁ существующее.

ПРАВИЛА:
- НЕ меняй структуру: все заголовки, их порядок и уровни — как есть; мета-блок в начале — как есть; существующие таблицы и списки НЕ удаляй и не сокращай.
- Расширяй СОДЕРЖАНИЕМ, а не водой: добавляй связные абзацы с конкретикой (цифры, примеры, сравнения, практические детали, ответы на смежные вопросы читателя) в САМЫЕ ТОНКИЕ секции — те, где 1-2 абзаца или один список.
- Добавляй ПРОЗУ (абзацы по 2-4 предложения), НЕ новые списки — списков в статье уже достаточно.
- Если у секции есть только список — допиши перед ним/после него 1-2 абзаца связного текста, раскрывающих пункты.
- FAQ-секцию НЕ трогай ВООБЩЕ: не переписывай вопросы и ответы, не добавляй вводных абзацев, не объединяй и не удаляй вопросы — расширяй ТОЛЬКО обычные секции.
- НЕ выдумывай факты: конкретику бери из уже написанного текста и общеизвестных достоверных знаний; сомнительное обобщай.
- Язык — ${args.language}. Стиль и голос — как в статье.
Верни ПОЛНУЮ статью целиком в Markdown, без преамбулы и без \`\`\`-обёрток.

СТАТЬЯ:
${args.article}`;
}

// ─── Text trim pass: cut an over-length article down to its target volume ────────────
// Verbose models overshoot budgets. This pass removes WATER — repeated ideas, filler
// paragraphs, bloated lists — while preserving every heading, table, and concrete fact.
export function buildTextTrimPrompt(args: { article: string; targetWords: number; currentWords: number; language: string }): string {
  return `Ты — жёсткий редактор. Ниже ГОТОВАЯ СТАТЬЯ (Markdown) объёмом ~${args.currentWords} слов при целевом объёме ~${args.targetWords} слов (перебор ${Math.max(0, args.currentWords - args.targetWords)} слов). СОКРАТИ её до целевого объёма (±10%), вырезая ТОЛЬКО воду.

ЧТО РЕЗАТЬ (в порядке приоритета):
1. Повторы одной мысли в разных секциях и внутри секции.
2. Абзацы-филлеры без конкретики («важно отметить», «стоит подчеркнуть», «как мы видим», общие рассуждения).
3. Раздутые списки: пункты без фактов удаляй, многословные ужимай до сути.
4. Многословные обороты → короткие формулировки (без потери смысла).

ЧТО НЕ ТРОГАТЬ:
- ВСЕ заголовки (H1/H2/H3), их порядок и уровни; мета-блок в начале.
- ВСЕ таблицы — целиком, со всеми строками.
- ВСЮ конкретику: цифры, цены, RTP, лимиты, даты, названия моделей/провайдеров/брендов, лицензии.
- FAQ-секцию (вопросы и ответы).
- Язык (${args.language}), стиль и голос статьи.

Верни ПОЛНУЮ статью целиком в Markdown, без преамбулы и без \`\`\`-обёрток.

СТАТЬЯ:
${args.article}`;
}

// ─── Per-section fact-check against real sources ─────────────────────────────────
export function buildFactCheckSectionPrompt(args: { heading: string; text: string; keyword: string; sources: { title: string; snippet: string; url: string }[] }): string {
  const src = args.sources.length
    ? args.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet} (${s.url})`).join("\n")
    : "(источников нет — оцени уверенностью модели)";
  return `Ты — строгий, но разумный фактчекер. Из секции "${args.heading}" (тема "${args.keyword}") выяви ПРОВЕРЯЕМЫЕ утверждения — целься в 5-10 фактов на секцию:
1) КОНКРЕТИКА: цифры, цены, даты, RTP, лимиты, wagering, время, характеристики, названия моделей/версий/продуктов/провайдеров, имена ритейлеров.
2) СУЩНОСТНЫЕ утверждения: лицензии и регуляторы (кто выдал, номер), кто оператор/владелец, год запуска, какие провайдеры/платёжные методы/рынки заявлены, легальность в регионе, доступность услуг.
3) ВЫВОДЫ ИЗ ПРОВЕРКИ: если источники ПОКАЗЫВАЮТ отсутствие подтверждения важного утверждения — сформулируй это как отдельный факт-вывод (например «Betlix не числится в реестре лицензиатов ANJ по данным источников») со статусом confirmed (вывод подтверждён источниками) и пометкой в note.
Чисто оценочные фразы без проверяемого ядра («удобный интерфейс», «надёжный сервис») пропускай.

ВАЖНО: источники НЕПОЛНЫЕ и часто из другого региона. «Нет в источниках» ≠ «неправда». Реальные бренды/модели (SpringWell, Fleck и т.п.), типичные характеристики и правдоподобные диапазоны цен по умолчанию считай ВЕРНЫМИ.

Статусы (будь снисходителен — большинство фактов должно быть confirmed):
- confirmed: подтверждается источниками ИЛИ это реальный/правдоподобный/общеизвестный факт (реальный бренд, типичная спека, разумный диапазон), который НЕ противоречит источникам. Отсутствие в сниппетах — НЕ повод снижать статус.
- partial: источник даёт ДРУГОЕ конкретное значение (есть реальное расхождение с источником) — укажи это значение в note.
- unconfirmed: ПРЯМО ПРОТИВОРЕЧИТ источникам ЛИБО явно невозможно/выдумано (несуществующая модель, абсурдная цифра). Только такие реально надо править.
НЕ помечай partial/unconfirmed факт лишь потому, что его нет в сниппетах — это главная ошибка, избегай её.
В "note" по возможности укажи ВЕРНОЕ значение из источника (например «в источнике [6] цена €469.99»), чтобы его можно было подставить. В "sources" — номера подтверждающих источников. НЕ выдумывай источники.
Верни СТРОГИЙ JSON без обёрток:
{ "status": "confirmed|partial|unconfirmed", "facts": [ { "claim": "конкретное утверждение", "status": "confirmed|partial|unconfirmed", "note": "верное значение/пояснение", "sources": [1,2] } ] }

СЕКЦИЯ:
${args.text.slice(0, 6000)}

ИСТОЧНИКИ:
${src}`;
}

// ─── Image-prompt generation (Hero + per-section) ────────────────────────────────
export function buildImagePromptsPrompt(args: { outlineJson?: any; article?: string; keyword: string }): string {
  const src = args.outlineJson ? `СТРУКТУРА (JSON):\n${JSON.stringify(args.outlineJson)}` : `СТАТЬЯ:\n${(args.article || "").slice(0, 12000)}`;
  return `Ты — арт-директор и SEO-редактор. По теме "${args.keyword}" составь промпты для генерации изображений к статье: один Hero Image и по одному промпту к ключевым секциям (visual_elements/важные H2). Промпты — на английском, конкретные, фотореалистичные или чистый flat-design инфографики, без текста на картинке.
Для КАЖДОГО изображения дай ещё SEO-атрибуты: "alt" (alt-текст, описывает картинку и содержит релевантный ключ, на языке статьи, ~8-12 слов) и "title" (короткий title-атрибут с ключом). Это нужно для SEO-оптимизации картинок (по методике Rush — у изображений должны быть Title и Alt с ключами).
Верни СТРОГИЙ JSON без обёрток:
{
  "hero": { "prompt": "english image prompt", "alt": "alt текст с ключом", "title": "title с ключом" },
  "sections": [ { "heading": "section heading", "prompt": "english image prompt", "alt": "alt текст с ключом", "title": "title с ключом" } ]
}

${src}`;
}

// Deterministic safety net: enforce link policy on generated text.
// - facts mode → strip ALL markdown links (keep anchor text)
// - any mode → strip links whose URL or anchor contains a banned word/topic token
export function enforceLinkPolicy(text: string, bannedTokens: string[], sourceMode?: "off" | "facts" | "cited"): string {
  if (!text) return text;
  const tokens = (bannedTokens || []).map(t => t.trim().toLowerCase()).filter(t => t.length > 1);
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, anchor, url) => {
    if (sourceMode === "facts") return anchor; // facts mode must not carry links
    const hay = `${anchor} ${url}`.toLowerCase();
    return tokens.some(tok => hay.includes(tok)) ? anchor : full;
  });
}

// Hard redaction: replace banned words/topics in prose with a neutral placeholder […].
// Aggressive — can affect phrasing, so it's opt-in. Returns count for a "check these" notice.
export function redactBannedWords(text: string, bannedTokens: string[]): { text: string; count: number } {
  let out = text || "";
  let count = 0;
  const tokens = (bannedTokens || []).map(t => t.trim()).filter(t => t.length > 1)
    .sort((a, b) => b.length - a.length); // longer phrases first
  for (const tok of tokens) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try { re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"); }
    catch { re = new RegExp(esc, "gi"); }
    out = out.replace(re, () => { count++; return "[…]"; });
  }
  return { text: out, count };
}

// ─── Vision structure extraction (Landing-flow "разобрать по скриншоту") ─────────
// The page has no semantic H-tags (or they're unreliable), so we ask a vision model to read the
// screenshot and reconstruct the visual heading hierarchy + an approximate word budget per section
// (estimated from how much text/space the section visually occupies).
export function buildVisionStructurePrompt(): string {
  return `Ты — веб-аналитик. На скриншоте — лендинг/страница сайта. Восстанови её ВИЗУАЛЬНУЮ иерархию заголовков (даже если в HTML нет тегов H1-H6 — ориентируйся на размер шрифта, жирность, расположение): главный заголовок = H1, крупные заголовки секций = H2, подзаголовки внутри секций = H3/H4.
Для КАЖДОГО заголовка укажи ПРИМЕРНЫЙ объём текста этой секции в словах (оцени по количеству видимого текста/абзацев/карточек под заголовком до следующего заголовка того же или более высокого уровня; если это просто список/карточки без текста — дай малую оценку 15-40).
Верни СТРОГИЙ JSON без преамбулы и без markdown-обёрток:
{ "title": "заголовок вкладки/страницы, если виден", "nodes": [ { "level": "H1|H2|H3|H4", "text": "текст заголовка как он написан на скриншоте", "words": 120 } ] }
Порядок — сверху вниз, как на экране. Не выдумывай заголовков, которых не видно на скриншоте.`;
}

// ─── Strict-JSON extraction (spec §6) ───────────────────────────────────────────
// Strips ```json fences and grabs the outermost {...} before JSON.parse.
export function extractJson<T = any>(raw: string | null): T | null {
  return extractJsonDetailed<T>(raw).data;
}

/**
 * Same parse as `extractJson`, but says whether the result came from the SALVAGE path.
 *
 * The salvage exists so a response cut off at the token ceiling still yields something usable
 * instead of nothing. What it must never do is pass that something off as a complete answer:
 * a partial outline parses cleanly, looks well-formed in every view, and quietly lacks the tail
 * of its own `sections` array plus every field the schema puts after it (`faq`,
 * `entity_analysis`). Downstream that reads as "the model chose to write 7 sections", and the
 * word-budget guard then spreads the full article target across those 7 — which is how a 2500-word
 * brief ends up asking for 480-word subsections. Callers that care check `repaired` and retry.
 */
export function extractJsonDetailed<T = any>(raw: string | null): { data: T | null; repaired: boolean } {
  if (!raw) return { data: null, repaired: false };
  let s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = s.indexOf("{");
  if (first === -1) return { data: null, repaired: false };
  s = s.slice(first);
  // 1) Straight parse of the largest {...} slice (works for complete output).
  const last = s.lastIndexOf("}");
  if (last > 0) { try { return { data: JSON.parse(s.slice(0, last + 1)) as T, repaired: false }; } catch { /* fall through */ } }
  // 2) Salvage TRUNCATED output (hit token limit mid-JSON): cut at the last fully-closed
  //    container and re-close the still-open parents, so we recover a valid partial outline.
  const repaired = repairTruncatedJson(s);
  if (repaired) { try { return { data: JSON.parse(repaired) as T, repaired: true }; } catch { /* give up */ } }
  return { data: null, repaired: false };
}

// Cut a truncated JSON string at the last position where a nested object/array fully closed,
// then append the closers for whatever containers were still open there. Ignores brackets/quotes
// inside strings. Always yields syntactically valid JSON (losing only the incomplete tail).
function repairTruncatedJson(s: string): string | null {
  const stack: string[] = [];
  let inStr = false, esc = false, cut = -1;
  let cutStack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") { stack.pop(); cut = i; cutStack = stack.slice(); }
  }
  if (cut === -1) return null;
  let out = s.slice(0, cut + 1).replace(/,\s*$/, "");
  for (let i = cutStack.length - 1; i >= 0; i--) out += cutStack[i];
  return out;
}
