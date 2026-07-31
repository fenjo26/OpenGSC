# Demand — план новой вкладки

Рабочий документ по интеграции идей из [every-app/open-seo](https://github.com/every-app/open-seo)
(MIT, 7.5k звёзд) в OpenGSC. Не спецификация к исполнению — разбор того, что там есть,
чего нет у нас, и как это ложится на существующую архитектуру.

---

## 1. Что такое OpenSEO на самом деле

Витрина над DataForSEO. Ни одного собственного источника данных: keyword research,
domain overview, backlinks, AI-видимость — всё это вызовы `api.dataforseo.com` через
официальный SDK `dataforseo-client`. Их хостинг зарабатывает 28% наценки на этих же
запросах, self-host платит DataForSEO напрямую.

Стек несовместим с нашим по всем осям:

| | OpenSEO | OpenGSC |
|---|---|---|
| Рантайм | Cloudflare Workers (wrangler, alchemy) | Node под PM2 на VPS |
| Сборка | Vite + TanStack Router | Next.js 16 App Router |
| ORM | Drizzle (D1 / Postgres) | Prisma 7 + SQLite |
| Кэш | R2 | таблицы SQLite |
| Пакеты | pnpm workspace | npm |

Порт кода = построчное переписывание. Лицензия MIT это разрешает, но выигрыш
близок к нулю: ценность не в их коде, а в наборе эндпоинтов DataForSEO и в том,
как они разложены по экранам.

**Вывод: берём карту эндпоинтов и продуктовые решения, пишем на своём стеке.**

---

## 2. Что у нас уже есть

Ключ `seoKey_dataforseo` подключён и используется в двух местах:

- `src/lib/seo/serp.ts` → `/v3/serp/{google,bing}/organic/live/advanced`
- `src/lib/seo/keywords.ts` → `/v3/dataforseo_labs/google/related_keywords/live`

То есть авторизация (HTTP Basic, login:password или Base64), разбор конверта
`status_code / tasks[0].result`, обработка ошибок — всё написано. Не хватает
только новых путей.

Дополнительно готовы к переиспользованию:

- **Слой метрик 1.1.0** — `metrics.ts` (Ahrefs/Semrush), `metricsStore.ts` (кэш,
  TTL, учёт юнитов, месячный кап), `metricsCsv.ts` (импорт выгрузок), модели
  `KeywordMetricCache`, `DomainMetricCache`, `CompetitorKeyword`,
  `KeywordVolumeHistory`, `ApiUsage`.
- **Паттерн платного вызова** — `fetch: false` по умолчанию (бесплатное чтение кэша),
  `fetch: true` только по нажатию, цена считается до запроса, кап проверяется
  сервером. См. `src/app/api/metrics/keywords/route.ts`.
- **Фоновые задачи** — `SeoJob` + fire-and-forget + polling.
- **MCP** — 34 тула, среди них уже `get_keyword_metrics`, `get_domain_metrics`,
  `get_competitor_gap`, `get_backlink_profile`.

**Новых провайдеров не нужно. Нужны новые эндпоинты на уже подключённом ключе.**

---

## 3. Карта эндпоинтов DataForSEO (из их кода)

Собрано из `src/server/lib/dataforseo/{labs,google-ads,ai,serp,backlinks}.ts`.

### Labs — исследование ключей

| Эндпоинт | Что даёт | Есть у нас |
|---|---|---|
| `dataforseo_labs/google/related_keywords/live` | связанные термины от сида | **да** |
| `dataforseo_labs/google/keyword_suggestions/live` | длинный хвост, содержащий сид | нет |
| `dataforseo_labs/google/keyword_ideas/live` | идеи по смыслу, а не по вхождению | нет |
| `dataforseo_labs/google/keyword_overview/live` | volume, KD, CPC, intent, помесячно | нет |
| `dataforseo_labs/google/domain_rank_overview/live` | сводка по домену | нет (есть Ahrefs-аналог) |
| `dataforseo_labs/google/ranked_keywords/live` | по каким ключам домен ранжируется | нет (есть Ahrefs-аналог) |
| `dataforseo_labs/google/relevant_pages/live` | топ-страницы домена по трафику | нет |
| `dataforseo_labs/google/serp_competitors/live` | кто пересекается по выдаче | нет (есть Ahrefs-аналог) |

### Keywords Data (Google Ads) — запасной источник

| Эндпоинт | Зачем |
|---|---|
| `keywords_data/google_ads/search_volume/live` | 217 стран против 94 у Labs |
| `keywords_data/google_ads/keywords_for_keywords/live` | идеи там, где Labs страну не знает |

### AI Optimization — видимость бренда в LLM

| Эндпоинт | Что даёт |
|---|---|
| `ai_optimization/llm_mentions/search/live` | упоминания бренда в ответах LLM |
| `ai_optimization/llm_mentions/aggregated_metrics/live` | агрегат по платформе |
| `ai_optimization/llm_mentions/cross_aggregated_metrics/live` | share of voice против конкурентов (2–10 групп) |
| `ai_optimization/llm_mentions/top_pages/live` | какие страницы цитируются чаще |
| `ai_optimization/{model}/llm_responses/live` | сырой ответ модели на промпт |

---

## 4. Ключевые продуктовые решения, которые стоит забрать

Из их `specs/0004-keyword-data-source-routing.md` — разобранные грабли, которые
иначе пришлось бы собирать самим:

1. **Каскад поиска ключей: related → suggestions → ideas.** Три эндпоинта отвечают
   на три разных вопроса. `related` — что рядом семантически. `suggestions` — длинный
   хвост с вхождением сида. `ideas` — по смыслу без вхождения. Один без остальных
   даёт узкий срез.
2. **Labs покрывает 94 страны, Google Ads — 217.** Роутинг по коду локации, без выбора
   провайдера пользователем. Для стран вне Labs нет KD и intent — это надо показывать
   в интерфейсе, а не молча отдавать `null`.
3. **`include_clickstream_data` удваивает цену запроса** и уточняет только объёмы.
   По умолчанию выключен, чекбокс с явной подписью про 2× стоимости.
4. **Батч метрик — до 700 ключей за запрос.**
5. **Кэш обязателен.** У них R2 с TTL: brand lookup 24 часа, ответы LLM 7 дней.
   У нас на это уже есть `KeywordMetricCache` с TTL 30 дней.

### Цены (их расчёты, self-host платит DataForSEO напрямую)

| Вызов | Labs | Labs + clickstream | Google Ads |
|---|---|---|---|
| research, 150 строк | $0.025 | $0.050 | $0.075 |
| research, 500 строк | $0.060 | $0.120 | $0.075 |
| метрики, 100 ключей | $0.020 | $0.040 | $0.075 |

Формула Labs: $0.01 за задачу + $0.0001 за строку.

---

## 5. Что предлагается сделать

### Demand — новая вкладка в главном меню

Два режима на одном экране, оба отвечают на вопрос, которого нет в Search Console:
**что происходит на рынке за пределами того, где я уже показываюсь.**

#### Режим «по ключу» — Keyword Research

Ввод: сид, страна, язык. Каскад related → suggestions → ideas, дедупликация,
одна таблица: ключ, объём, KD, CPC, intent, тренд за 12 месяцев.

Отличие от Ahrefs и от самого OpenSEO — **колонка «ты»**: join с нашими данными GSC.
Для каждого найденного ключа сразу видно, показываемся ли мы по нему, на какой позиции,
какой страницей. Те же три вердикта, что уже работают в `/competitors`:

- **в досягаемости** — топ-30, править существующую страницу;
- **не та страница** — показы есть, ничего не выигрывает, промах по интенту;
- **нет контента** — писать.

Ни Ahrefs, ни OpenSEO вторую половину этого join не знают: у них нет нашей истории GSC.

Самое приятное: этот join уже написан. В `src/app/api/metrics/gap/route.ts` (строки 70–100)
`DailyMetric` группируется по `query` + `url`, из группы берётся лучшая позиция, и
результат складывается с внешними ключами. Для Demand меняется только источник внешней
стороны — вместо `CompetitorKeyword` туда приходят строки из Labs. Логика вердиктов
переносится как есть.

Действия со строками: сохранить в список, отправить в Rank Tracker, отправить
в Outline Generator, CSV.

#### Режим «по домену» — Domain Overview

Ввод: любой домен. `domain_rank_overview` + `ranked_keywords` + `relevant_pages` +
`serp_competitors`. Сводка, ключи, топ-страницы, пересечение по выдаче.

Пересекается с существующей `/competitors`, но не дублирует: там анализ
**против конкретного нашего сайта** (gap), здесь — профиль **произвольного домена**
сам по себе. Стоит свести их в один экран с переключателем «сам по себе / против моего сайта»,
а не держать две вкладки.

### Brand Lookup и Prompt Explorer — не сюда

Оба про AI-видимость, и у нас для неё уже есть три места: AEO Tracker, GEO Audit, Citations.
Логичнее добавить `llm_mentions` **вторым источником данных в AEO Tracker**, а не
новой вкладкой:

- AEO сейчас отвечает «цитируют ли меня по МОИМ вопросам» — живой опрос своими ключами
  к четырём движкам, история по каждому вопросу.
- `llm_mentions` отвечает «насколько мой бренд вообще заметен и как это выглядит против
  конкурентов» — агрегированный индекс DataForSEO, обновляется примерно раз в месяц.

Это дополняющие данные, а не альтернативные. Share of voice против 2–10 конкурентов —
то, чего у нас нет вообще.

**Prompt Explorer — самый слабый пункт из четырёх.** Он делает то же, что AEO, но
разово и через ключ DataForSEO вместо своих ключей к моделям. Единственная реальная
ценность: работает без ключей OpenAI/Anthropic/Perplexity/xAI. Если делать — то
кнопкой «спросить разово» внутри AEO, не отдельным разделом.

---

## 6. Как это ложится на архитектуру

### Маршруты

```
src/app/demand/page.tsx              # вкладка, два режима через таб внутри
src/app/api/demand/keywords/route.ts # каскад related/suggestions/ideas + join c GSC
src/app/api/demand/domain/route.ts   # domain_rank_overview + ranked_keywords + relevant_pages
src/lib/seo/demand.ts                # клиент DataForSEO Labs — по образцу metrics.ts
src/lib/seo/demandStore.ts           # кэш и учёт трат — по образцу metricsStore.ts
```

Если каскад по трём эндпоинтам окажется дольше ~30 секунд — переводить на `SeoJob`
(fire-and-forget + polling), как уже сделано в кластеризации.

### Prisma

Новых моделей минимум. `KeywordMetricCache` уже хранит ровно те поля, что возвращает
Labs (volume, difficulty, cpc, intents, payload) — достаточно писать туда с
`provider: "dataforseo"`. Составной ключ `[keyword, country, provider]` это уже допускает.

Новое нужно только под сохранённые списки:

```prisma
model SavedKeyword {
  userId    String
  keyword   String
  country   String   @default("us")
  tag       String   @default("")
  siteId    String?  // если ключ пришёл из join с конкретным сайтом
  createdAt DateTime @default(now())

  @@id([userId, keyword, country])
  @@index([userId, tag])
}
```

Писать через `$queryRawUnsafe`, как остальные поздние таблицы — чтобы вкладка не падала
на базе, где ещё не прогнали `prisma db push`.

### i18n

Плоские ключи с префиксом `dm` (свободен, проверено), три локали синхронно:
`en.json`, `ru.json`, `uk.json` — сейчас по 2476 ключей в каждом, расхождений нет,
и это состояние надо сохранить. Подстановка через `.replace("{n}", …)`, как везде.

### Стиль

Инлайн-стили на `var(--color-*)`, без Tailwind. Готовые классы: `.card`, `.panel`,
`.pill`, `.tool-input`, `.metric-chip`. Разделители в коде — `// ─── Название ───`.

### Sidebar

Пункт добавляется в массив в `src/components/Sidebar.tsx` (строки 79–83).
Иконка из `lucide-react` — например `Search` или `Compass`.

### MCP

Два новых тула, оба `cost: "paid"` или `"quota"` в зависимости от того, считаем ли
мы траты DataForSEO платными (считаем — это деньги владельца):

- `research_keywords` — сид → ключи с метриками и вердиктами по нашему GSC;
- `get_domain_overview` — домен → сводка, ключи, страницы, конкуренты.

Оба обязаны требовать `confirm: true` через `assertConfirmed()`, как уже сделано
для `start_rewrite_job` и `start_generation_job`.

---

## 7. Порядок работ

1. `src/lib/seo/demand.ts` — четыре функции Labs (related, suggestions, ideas, overview)
   + роутинг на Google Ads для стран вне Labs. Расчёт цены до запроса.
2. `POST /api/demand/keywords` — каскад, дедупликация, кэш-первым, join с `DailyMetric`.
3. Экран `/demand`, режим «по ключу». Ключи i18n в трёх локалях.
4. Действия: сохранить, в Rank Tracker, в Outline Generator, CSV.
5. Режим «по домену» + слияние с существующей `/competitors`.
6. MCP-тулы + скилл в `.agents/skills/`.
7. Отдельной задачей: `llm_mentions` вторым источником в AEO Tracker.

---

## 8. Открытые вопросы

- **Имя `demand` уже занято наполовину.** Есть `POST /api/metrics/demand` — проверка
  тренда спроса для Content Decay, и колонка «Demand» в самой карте затухания.
  Технически коллизии нет (`/demand` и `/api/metrics/demand` сосуществуют), концептуально
  это то же понятие в большем масштабе. Либо принять как расширение термина, либо
  переименовать вкладку.
- **Что делать со вкладкой `/competitors`** — свести в Demand или оставить отдельно.
- **Работа без ключа.** У проекта принцип «ничего не обязательно». Без ключа DataForSEO
  вкладка должна показывать то, что уже в `KeywordMetricCache` (включая пришедшее
  из CSV-импорта Ahrefs/Semrush) плюс наши данные GSC — а не пустой экран.
