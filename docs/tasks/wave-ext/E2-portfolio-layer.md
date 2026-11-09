# E2 — слой OpenGSC для своих страниц

Когда в панели открыта страница из портфеля, вкладка «OpenGSC» показывает то, чего нет ни в
одном стороннем расширении: что Google знает про эту страницу у тебя в GSC, совпадает ли она
со своим запросом, и не повторяет ли её шаблон title/description другие сайты сетки.

Владеешь: `extension/panel/tab-opengsc.js`, `src/app/api/ext/insights/route.ts`,
`src/app/api/ext/meta-fit/route.ts`, `src/lib/ext/insights.ts`, `src/lib/ext/insights.test.ts`.

## 1. Сигнатуры (`src/lib/ext/insights.ts`)

```ts
import type { InsightsRequest, InsightsResponse, FootprintHit } from "./types";
import type { FootprintItem } from "@/lib/footprint";

/** Everything the panel's OpenGSC tab needs beyond GET /api/ext/page. DB-bound. */
export async function pageInsights(userId: string, req: InsightsRequest): Promise<InsightsResponse>;

// ── pure (tested) ──
export function pickMainQuery(rows: { query: string; clicks: number; impressions: number; position: number }[]):
  { query: string; clicks: number; impressions: number; position: number } | null;
export function footprintHits(
  page: { siteId: string; url: string; title: string; description: string; h1: string; entities: string[] },
  items: FootprintItem[],
  opts?: { threshold?: number; minWords?: number; maxMatches?: number },
): FootprintHit[];
```

## 2. `pageInsights`

1. Сайт — как в `/api/ext/page`: `normalizePageUrl` → `matchPortfolioSite` → `urlVariants`
   (`src/lib/ext/urlMatch.ts`). Не из портфеля → `{ inPortfolio: false, … остальное null/[] }`.
2. **Главный запрос.** Строки `DailyMetric` по вариантам URL с непустым `query` за
   `EXT_QUERY_WINDOW_DAYS` (тот же запрос, что в `page/route.ts`), сгруппировать по запросу,
   `pickMainQuery`: больше кликов → больше показов → меньше позиция → по алфавиту
   (детерминированно). Позиция — среднее по строкам, 1 знак. Нет строк → `null`.
3. **Совпадение с запросом** — `pageMatchesQuery(title, h1, mainQuery.query)` из
   `src/lib/audit/queryAlign.ts`. Это та же логика, что правило аудита `title_query_mismatch`,
   поэтому панель и аудит не спорят друг с другом. Без главного запроса → `null`.
4. **В sitemap.** Есть строка `SitemapUrl` (варианты URL, `inventoryStatus: "active"`) → `true`;
   строки нет, но у сайта вообще есть инвентарь sitemap → `false`; инвентаря нет → `null`
   («sitemap не загружен в OpenGSC»).
5. **Мета.** Если главный запрос есть: `fitMetaLocal("title", title, [], mainQuery.query)` и
   то же для description. Если исходное значение уже `inBand` — `null` (показывать нечего).
   LLM здесь не вызывается никогда.
6. **Футпринт.** `collectPortfolio(userId)` из `@/lib/footprint` (у неё свой кеш — не
   добавляй свой). Сущности страницы — `siteEntities(site.url, <brandedKeywords сайта>)`, как
   их считает `store.ts`. Затем `footprintHits`.

## 3. `footprintHits` (чистая)

- Скелет каждой из трёх строк страницы — `skeletonOf(text, entities)`. Скелет короче
  `MIN_SKELETON_WORDS` слов → пропускаем (короткие шаблоны вроде «{x} — главная» совпадают у
  всех и шумят; тот же порог, что в отчёте `/footprint`).
- Кандидаты — `items` того же `kind` с **другой** identity (`identity !== page.siteId`, а для
  generated — любые). Какой именно id `collectPortfolio` кладёт в `identity` (`Site.id` или
  `Site.siteId`), проверь в `footprint/store.ts` и передавай тот же. Своя же страница и другие страницы того же сайта — не футпринт.
- Сходство: точное совпадение скелета = 1.0; иначе Jaccard по словам без `{x}` и пунктуации.
  Функции `similarityWords`/`jaccard` в `skeleton.ts` не экспортированы, а трогать
  `footprint/**` нельзя — скопируй их в `insights.ts` (пометь «копия из skeleton.ts») и в тесте
  проверь, что на фикстуре твоя функция и `similarGroups()` объединяют одни и те же пары.
- Порог — `SIMILARITY_THRESHOLD` (0.85). Совпадения сортировать по сходству, до 5 на kind.
  В ответ попадают только kind с совпадениями.

## 4. `POST /api/ext/insights`

`extAuth(req, "read")` → тело `InsightsRequest` (title/description/h1 обрезать до 500
символов, URL — `normalizePageUrl`, иначе `400 invalid_url`) → `pageInsights`. Нет таблиц →
`{ notMigrated: true }` (`extTablesMissing` или `footprintSchemaMissing`).

## 5. `POST /api/ext/meta-fit`

- `allowLlm` не задан или false → `extAuth(req, "act")`, `fitMetaLocal` для обоих полей,
  `llmCalls: 0`.
- `allowLlm: true` → `extAuth(req, "spend")`; без `confirm: true` →
  `400 { error: "confirm_required", estimate: { maxCalls: 2, note: "your AI key" } }`.
  Ключи провайдера — так же, как в `src/app/api/seo/meta-fit/route.ts` для серверных вызовов:
  `resolveAiCreds` из `@/lib/mcp/shared` (расширение ключей не присылает). Вызов — внутри
  `withCallContext`, как там же, чтобы он попал в журнал провайдеров.
- `keyword` для `MetaFitItem` — главный запрос (`pageInsights` → `mainQuery`; если его нет →
  `400 { error: "no_main_query" }`: подгонять без запроса нельзя — потеряем ключ в начале title).
  `language` — из тела или `"en"`.
- Ничего не сохраняет. Это подсказка: копировать в CMS человек будет сам.

## 6. Вкладка — `panel/tab-opengsc.js`

`Panel.register({ id: "opengsc", order: 20, applies: ctx => !!(ctx.summary && ctx.summary.inPortfolio) })`.

Сверху вниз:

1. **Сайт и ссылка** «Открыть в OpenGSC» (`summary.site.openPath`).
2. **GSC за 28 дней** — клики, показы, позиция; топ-5 запросов (из `summary`). Перенеси
   рендер из `popup.js` (не импортируй: попап — файл E1; скопируй функцию).
3. **Главный запрос** — запрос, клики. Ниже вердикт: «title/H1 содержит запрос ✓» или
   «title и H1 не содержат главный запрос» (жёлтый, с текстом, не только цветом).
4. **Индекс** — из `summary.index` (как в попапе) + строка «В sitemap: да / нет / sitemap не
   загружен». Кнопка «Проверить индексацию» → существующий `MSG_SEND`-путь (index-queue).
5. **Мета.** Для title и description: текущее значение, длина, полоса. Если есть предложение
   `meta.*` — «Предложение: … (N симв.)» + «Копировать». Кнопка «Подобрать с ИИ» → диалог в
   панели: «До 2 запросов к вашей модели ИИ. Подтвердить?» → `ExtApi.metaFit({ …, allowLlm: true, confirm: true })`.
   Ответ `403 forbidden` → «У вашей роли нет права тратить кредиты».
6. **Футпринт.** Нет совпадений → «Шаблон title/description/H1 не повторяется на других
   сайтах сетки ✓». Есть → по каждому kind: скелет страницы (с `{x}`), список совпадений
   (сайт, текст, сходство %), ссылка «Все шаблоны сетки» → `/footprint` в OpenGSC.
7. **Ранги** — из `summary.ranks`, как в попапе.
8. **Аудит сервера** — проблемы последнего аудита по этой странице (из `summary.audit`).

Запросы: `summary` уже в `ctx`; `insights` — один запрос при рендере, кеш в `ctx.cache` на
5 минут по URL + title (если title на странице поменялся — перезапрос).

Title, description и H1 бери из `ctx.scan.facts` (`title`, `description`, `h1Text` — поля N11),
а не из `detail`: они есть даже когда `detail` не успел.

## 7. Тесты — `src/lib/ext/insights.test.ts`

`pickMainQuery` (ничьи, пустой ввод), `footprintHits` (своя identity исключена; короткий
скелет пропущен; точное совпадение = 1; почти-совпадение выше и ниже порога; generated-строки;
не больше 5 совпадений), сверка своей Jaccard с `similarGroups`.

## 8. Ключи

Расширение (en · ru):

| ключ | en | ru |
|---|---|---|
| `tabOpengsc` | OpenGSC | OpenGSC |
| `ogOpenInApp` | Open in OpenGSC | Открыть в OpenGSC |
| `ogGsc28` | Google Search Console, 28 days | Google Search Console, 28 дней |
| `ogMainQuery` | Main query | Главный запрос |
| `ogMatchOk` | Title/H1 contain the main query | Title/H1 содержат главный запрос |
| `ogMatchBad` | Neither title nor H1 contains the main query | Ни title, ни H1 не содержат главный запрос |
| `ogNoMainQuery` | No queries for this URL in the last 28 days | За 28 дней по этому URL нет запросов |
| `ogInSitemap` | In sitemap | В sitemap |
| `ogSitemapYes` | yes | да |
| `ogSitemapNo` | no | нет |
| `ogSitemapUnknown` | sitemap not loaded in OpenGSC | sitemap не загружен в OpenGSC |
| `ogCheckIndex` | Check indexing | Проверить индексацию |
| `ogMeta` | Meta tags | Мета-теги |
| `ogSuggestion` | Suggestion ($1 chars) | Предложение ($1 симв.) |
| `ogCopy` | Copy | Копировать |
| `ogCopied` | Copied | Скопировано |
| `ogFitAi` | Fit with AI | Подобрать с ИИ |
| `ogFitAiConfirm` | Up to 2 requests to your AI model. Continue? | До 2 запросов к вашей модели ИИ. Продолжить? |
| `ogNoSpendRight` | Your role can't spend credits | У вашей роли нет права тратить кредиты |
| `ogNoMainQueryFit` | Can't fit without a main query | Без главного запроса подгонять нельзя |
| `ogFootprint` | Footprint across your sites | Футпринт по сетке |
| `ogFootprintClean` | This title/description/H1 pattern is not repeated on your other sites | Шаблон title/description/H1 не повторяется на других сайтах сетки |
| `ogFootprintKindTitle` | Title pattern | Шаблон title |
| `ogFootprintKindDescription` | Description pattern | Шаблон description |
| `ogFootprintKindH1` | H1 pattern | Шаблон H1 |
| `ogFootprintAll` | All patterns | Все шаблоны сетки |
| `ogSimilarity` | $1% alike | сходство $1% |
| `ogRanks` | Rank Tracker | Rank Tracker |
| `ogServerAudit` | Last site audit | Последний аудит сайта |
