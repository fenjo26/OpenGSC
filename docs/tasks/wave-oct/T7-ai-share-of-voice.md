# T7 — Доля голоса в ответах ИИ, цитируемые домены, вопросы из GSC, Gemini

**Ветка:** `feat/wave-oct-t7` от `feat/wave-oct`, worktree `.worktrees/wave-t7`.
**Владение:** `README.md` §4, строка T7.

## Зачем

Руслан прислал `elmohq/elmo` — self-hosted альтернативу Profound/Peec/Otterly. Главное в таких
инструментах: **доля голоса** (как часто ИИ называет тебя, а как часто — конкурентов) и
**какие источники ИИ цитирует** (туда и надо попадать). Наш AEO-трекер отвечает только
«процитирован / упомянут / нет» по каждому вопросу и движку.

Ключевой факт: `AeoCheck` уже хранит `answerText` (полный ответ) и `citations` (JSON
`[{url, domain, title}]`) — смотри комментарий в `schema.prisma` у модели `AeoCheck`. Значит,
доля голоса и рейтинг доменов — **чистая агрегация уже купленных данных**. Добавили
конкурента — пересчитали всю историю бесплатно. Это главный принцип задачи: никаких новых
платных вызовов, кроме нового движка Gemini, который пользователь включает сам.

## Что сделать

### 1. Чистая логика — `src/lib/visibility/sov.ts`
- `mentionsOf(text, terms)`: граница слова по Unicode (`\p{L}\p{N}`), без регистра и
  диакритики. Термы короче 3 символов игнорируются. Домен в тексте (`example.com`) тоже
  засчитывается.
- `latestPerQuestionEngine(answers, from, to)`: для каждой пары (вопрос, движок) берётся
  последний ответ в окне. Иначе вопрос, проверенный 30 раз, весит в 30 раз больше
  проверенного один раз. Ответы с `error` и без `answerText` не участвуют.
- `buildSovReport`:
  - **shareOfVoice** — по каждому ответу: упомянуты ли мы (`status ∈ {cited, mentioned}` или
    `mentionsOf(answerText, us.terms)`), упомянут ли каждый конкурент (`name` + `terms` +
    `domain`). Доля = упоминания бренда / сумма упоминаний всех брендов. Если брендов не
    упомянуто нигде — `share = 0` у всех, а UI показывает «нет данных», а не 0 %.
  - **citationShare** — то же по `citations`: домен принадлежит нам (совпадение с хостом по
    границе точки, как `isOurs` в `aeo.ts`) или конкуренту (по `domain`).
  - **byEngine** — разбивка по движку; `avgRank` — среднее `AeoCheck.rank`, где он не null.
  - **trend** — ISO-недели окна: доля голоса «нас» за неделю (null, если ответов нет).
- `buildCitedDomains`: домены из `citations` (без `www.`), сортировка по `answers`, потом по
  `citations`. Пометки `isUs`, `competitor`. Пример вопроса и URL — из самого свежего ответа.
- `questionLike(query, lang)`: начинается с вопросительного слова или содержит «?». Списки
  слов для en/fr/es/de/it/pt/ru/uk/el (how/what/which/best/vs/… ; comment/quel/meilleur/… ;
  как/что/какой/лучший/… ; πώς/τι/ποιο/καλύτερο/…) — в модуле.

### 2. Хранилище — `src/lib/visibility/store.ts`
- `sovForSite(userId, siteDbId, days)`: один запрос `AeoCheck` join `TrackedQuestion` по сайту
  за окно (`days` ∈ 7/30/90, по умолчанию 30), только нужные поля. `answerText` может быть
  большим — ограничь выборку окном и не более 5000 строк; если строк больше — возьми последние
  и верни это в `report.window` как фактическую границу.
- Бренд «нас» — `brandTermsFor(host, parseBrandTerms(site.brandedKeywords))` (обе функции уже
  есть в `aeo.ts` / `aeoTracker.ts`).
- `getCompetitors` / `saveCompetitors` — `Site.aeoCompetitors`: максимум 10 конкурентов, домен
  нормализуется (без схемы, `www.`, пути).
- `suggestQuestions`: `DailyMetric` сайта за 28 дней (`query ≠ ''`, `searchType = "web"`), group
  by `query` → сумма показов и кликов, фильтр `questionLike`, минус уже отслеживаемые
  `TrackedQuestion.question` (сравнение без регистра), сортировка по показам, `limit` ≤ 50.
  Страница — URL с наибольшими показами по этому запросу.

### 3. Gemini как пятый движок
- `AeoEngine` += `"gemini"` в `aeo.ts`, `AEO_ENGINES` дополнить, `checkGemini(apiKey, question,
  domain, brandTerms, o)` по образцу `checkPerplexity`: `generateContent` с инструментом
  `google_search` (grounding). Цитаты — из `candidates[0].groundingMetadata.groundingChunks[].web`
  (`uri`, `title`). `uri` — редирект `vertexaisearch.cloud.google.com/grounding-api-redirect/…`,
  а домен источника обычно лежит в `title`. Возьми домен из `title`, если он похож на хост, иначе
  оставь пустым: **не** раскрывай редиректы на каждом ответе. `searched = true`, если есть
  `webSearchQueries`.
- Модель — актуальная Flash-модель с поддержкой grounding. Проверь список в `src/lib/llm.ts`
  или провайдерах и вынеси id в константу `AEO_GEMINI_MODEL` (не хардкодь в двух местах).
- Ключ: если в `src/lib/llm.ts` / настройках SEO Tools уже есть ключ Gemini, `getUserAeoCreds`
  берёт его оттуда. Новое поле в настройках не нужно — напиши в отчёте, откуда ключ.
- В `AeoTracker.tsx` движок появляется везде, где перечислены остальные (иконка, подпись
  `aeoEngineGemini`, колонка, фильтр).
- Grounding у Gemini платный сверх бесплатного лимита. Перед первой проверкой в UI — та же
  плашка цены, что у остальных движков (найди, как она сделана).

### 4. Чистка после хаба
Хаб «Видимость» (T0) показывает `BrandVisibility` на отдельной подвкладке «LLM Mentions».
Убери `<BrandVisibility siteDbId={siteDbId} />` из конца `AeoTracker.tsx` (строка ~819),
иначе он отрисуется дважды.

### 5. UI
**`AiShareOfVoice.tsx`** (подвкладка «Доля голоса»):
- переключатель окна 7/30/90 (`aiSovWindow`), подпись `aiSovHint`;
- два горизонтальных бар-чарта «Доля голоса» и «Доля цитирований»: «Вы» выделены цветом,
  конкуренты — нейтральным. Подписи значений — на самих барах. Перед графиками прочитай skill
  `dataviz`;
- таблица `aiSovByEngine`: движок × (ответов, упомянуты, процитированы, средняя позиция,
  лучший конкурент);
- спарклайн `aiSovTrend`;
- блок `aiSovCompetitors`: список с удалением, форма `aiSovAddCompetitor` (`aiSovCompName`,
  `aiSovCompDomain`, `aiSovCompTerms` — чипы). После сохранения отчёт пересчитывается сразу —
  подтверждение того, что это бесплатно;
- `aiSovNoData`, если ответов в окне нет, со ссылкой на подвкладку «Ответы ИИ».

**`CitedDomains.tsx`** (там же, ниже):
- `aiCitedTitle`, `aiCitedHint`; таблица «домен · `aiCitedCitations` · `aiCitedAnswers` ·
  движки · пример вопроса»; свои домены и домены конкурентов помечены;
- `aiCitedToOutreach` → сохранить домен как prospect (та же серверная функция, что у MCP
  `save_outreach_prospect`; маршрут `POST /api/aeo/cited-to-outreach` из контракта §4).

**`AeoTracker.tsx`** — блок `aiSuggestTitle` рядом с формой добавления вопроса: до 20 идей из
`/api/aeo/suggest-questions` с показами, кнопка `aiSuggestAdd` добавляет вопрос тем же путём,
что ручной ввод. Пусто — `aiSuggestEmpty`.

### 6. MCP — `toolsVisibility.ts`
`get_ai_share_of_voice` (`local`): `site`, `days` → `{ report, cited }`.

### 7. Документация — `docs/VISIBILITY.md` (твой файл)
Что такое вкладка «Видимость», чем отличаются четыре подвкладки (живые ответы на ваши вопросы ·
агрегаты по ним · новости и Википедия · индекс DataForSEO), как считаются доли и почему это
бесплатно. Раздел про упоминания пришлёт T6 — оставь заголовок `## Упоминания` с пометкой
«заполняет T6», R вставит текст.

## Не делать
- Анализ тональности (sentiment) через LLM — это новые платные вызовы. Он в бэклоге.
- Google AI Overviews как движок — в бэклоге (источник есть в SERP Monitor: A-Parser отдаёт
  `ai_answer`, но это отдельная задача).
- Не менять `AeoCheck`: всё нужное в нём уже есть.

## Тесты — `src/lib/visibility/*.test.ts`
- `mentionsOf`: граница слова, диакритика, короткие термы игнорируются, домен в тексте.
- `latestPerQuestionEngine`: 5 ответов одной пары → берётся один последний; ошибочные
  отброшены.
- `buildSovReport` на ручной фикстуре из 6 ответов, 2 движков и 2 конкурентов: доли
  совпадают с посчитанными вручную (впиши расчёт в комментарий теста); ноль упоминаний →
  «нет данных», а не деление на ноль.
- `buildCitedDomains`: `www.` схлопывается, `isUs` и `competitor` проставлены, сортировка.
- `questionLike`: по 3 положительных и отрицательных примера на en, fr, ru, el.
- Разбор ответа Gemini с `groundingMetadata` из фикстуры.

## Проверка
```bash
npx tsx --test src/lib/visibility/*.test.ts
npm run check
npx eslint src/lib/visibility src/lib/seo/aeo.ts src/lib/aeoTracker.ts src/lib/aeoScheduler.ts \
  src/components/AeoTracker.tsx src/components/visibility/AiShareOfVoice.tsx src/components/visibility/CitedDomains.tsx \
  src/app/api/aeo src/lib/mcp/toolsVisibility.ts
```
Ручная — пункт 6 чеклиста `README.md` §8: добавить двух конкурентов и убедиться по журналу
провайдеров (`/settings` → Provider log), что новых запросов к ИИ не было.
